import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CLICK_SLOP_PX, createOrbit } from "./controls.js";
import {
  isDryFloor,
  EQUIPMENT_ACTION_MS,
  CHAT_BUBBLE_MS,
  DIR_SCALE,
  facingFromDir,
  footprintTiles,
  getZone,
  GHOST_HAUNT_FRESH_MS,
  hogSize,
  hogStyleFor,
  PLAYER_RESPAWN_MS,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  MAX_TREES_PER_ZONE,
  projectMotion,
  projectMotionState,
  snapToTile,
  STARTING_ZONE_SLUG,
  tileKey,
  timestampMs,
  troggColorFor,
  troggStyleFor,
  zoneBounds,
  type Coord,
  type Stamp,
  type ZoneBounds,
  type Zone,
} from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import type { Boulder, GroundItem, Hog, Player, Tree } from "../net/module_bindings/types";
import { attachKeyboard, isTyping, type MoveIntent } from "../input.js";
import { setupChat } from "../ui/chat.js";
import { mountCommands } from "../ui/commands.js";
import { createSelfController, type SelfController } from "../movement.js";
import { captureEvent, isFeatureEnabled, logError, logInfo } from "../analytics.js";
import { audio } from "../audio.js";
import { interact, useEquipped } from "../net/procedures.js";
import { isOlderPlayerMotion, playerMotionChanged, withPlayerMotion } from "../motion_sync.js";
import { FarCrowd } from "./crowd.js";
import { createEntities, disposeObject, type Entities, type HogView, type Tracked } from "./entities.js";
import { buildBoulder, buildTree } from "./items.js";
import { NodeField } from "./nodes.js";
import { buildTerrain, type Terrain3D } from "./terrain.js";
import { DAYLIGHT_3D, UI_3D } from "./palette.js";

/** Fraction of the viewport the zone fills, leaving a rim of cave around it. */
const ZONE_FILL = 0.92;
/** The 3/4 camera direction: south of the zone and above, looking down-north. */
const CAMERA_DIR = new THREE.Vector3(0, 1.35, 1).normalize();

function timestampBaseMs(movedAt: Stamp): number {
  const elapsedMs = Math.max(0, Date.now() - timestampMs(movedAt));
  return performance.now() - elapsedMs;
}

function playerFacing(p: Pick<Player, "dirX" | "dirY" | "faceX" | "faceY">): { dirX: number; dirY: number } {
  return p.dirX !== 0 || p.dirY !== 0 ? { dirX: p.dirX, dirY: p.dirY } : { dirX: p.faceX, dirY: p.faceY };
}

export interface WorldData {
  conn: DbConnection;
  /** The zone to render and subscribe to — the local trogg's current zone. */
  slug: string;
}

/**
 * The 3D game world (GDD "Camera and rendering"): renders the zone in Three.js and
 * runs the per-frame extrapolation loop. Movement stays intent-based — the `player`
 * table syncs origin/direction/start-time and every client extrapolates locally each
 * frame (invariant 2); all authority stays server-side (invariant 3).
 */
/** One full in-game day, dawn to dawn. */
const DAY_CYCLE_MS = 12 * 60 * 1000;

/** World objects beyond this many tiles from the camera focus stop rendering. */
const CULL_RANGE = 72;

/** How many troggs (and, separately, Hogs) render at once: the nearest N within
 *  CULL_RANGE. A rig is ~20 draw calls, so an unbounded crowd is a slideshow. */
const CREATURE_BUDGET = 16;

/** How many equipped torches shed real light at once (nearest first). */
const TORCH_LIGHT_BUDGET = 4;

/** The render loop's ceiling. ProMotion displays drive the animation loop at
 *  120Hz+, which doubles CPU/GPU heat for no gameplay benefit — excess ticks
 *  are dropped whole (no projection, no render). */
const FRAME_CAP_FPS = 60;



export class World3D {
  /** The local trogg's live projected position (the overworld map marker). */
  selfPosition(): { x: number; y: number } | undefined {
    return this.selfPos;
  }

  private readonly conn: DbConnection;
  private readonly slug: string;
  private readonly zone: Zone;
  private myId?: string;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private orbit?: OrbitControls;
  private readonly parent: HTMLElement;
  private terrain!: Terrain3D;
  private entities!: Entities;
  private self!: SelfController;
  private destination!: THREE.Mesh;

  private readonly tracked = new Map<string, Tracked>();
  private readonly boulders = new Map<string, Boulder>();
  private readonly trees = new Map<string, Tree>();
  /** All trees (and, separately, boulders) draw as a handful of instanced meshes. */
  private treeField!: NodeField;
  private boulderField!: NodeField;
  /** Creatures beyond the full-rig budget render as moving silhouettes, not nothing. */
  private crowd!: FarCrowd;
  /** Cleared until the camera has snapped to the local trogg once (first snapshot). */
  private cameraSnapped = false;
  /** Whether the local trogg currently has the fly cheat on. */
  private selfFlying(): boolean {
    return (this.myId && this.tracked.get(this.myId)?.player.cheatFly) === true;
  }

  /** Tiles between the local trogg and a world position — Infinity before spawn. */
  private hearingDistance(x: number, y: number): number {
    if (!this.selfPos) return Infinity;
    return Math.hypot(x - this.selfPos.x, y - this.selfPos.y);
  }

  /** Hide world objects beyond what the fog reveals: the seamless world renders
   *  only what is around you (the row data still syncs; this is draw-cost only).
   *
   *  Creatures also carry a **visibility budget** (the glowmoss light budget's
   *  pattern): a jointed rig is ~20 draw calls plus overlay sprites and a shadow
   *  pass, so a hundred players inside the radius would mean thousands of draws.
   *  Only the nearest `CREATURE_BUDGET` of each kind render; the rest hide until
   *  the crowd thins. Hidden creatures still project, collide, and make sound —
   *  this is draw cost only. */
  private cullDistant(range: number): void {
    if (!this.orbit) return;
    const fx = this.orbit.target.x;
    const fy = this.orbit.target.z;
    const dist = (obj: THREE.Object3D) => Math.hypot(obj.position.x - fx, obj.position.z - fy);
    const inRange = (obj: THREE.Object3D) => dist(obj) < range;
    const budget = (markers: { marker: THREE.Group; keep?: boolean }[]) => {
      const ranked = markers
        .map((m) => ({ ...m, d: m.keep ? -1 : dist(m.marker) }))
        .sort((a, b) => a.d - b.d);
      ranked.forEach((m, i) => {
        m.marker.visible = m.d < range && i < CREATURE_BUDGET;
      });
    };
    budget([...this.tracked.entries()].map(([id, entry]) => ({ marker: entry.marker, keep: id === this.myId })));
    budget([...this.hogs.values()].map((view) => ({ marker: view.marker })));
    // Torch firelight has its own, tighter budget: point lights cost every
    // fragment in a forward renderer (the glowmoss budget's reasoning), so only
    // the nearest few visible torch-bearers actually shed light — the rest still
    // show a glowing flame.
    const torches = [...this.tracked.values()]
      .filter((entry) => entry.torchLight && entry.marker.visible)
      .sort((a, b) => dist(a.marker) - dist(b.marker));
    torches.forEach((entry, i) => {
      entry.torchLight!.visible = i < TORCH_LIGHT_BUDGET;
    });
    // trees and boulders are instanced whole-zone draws — nothing to cull per node
    for (const view of this.groundItems.values()) view.group.visible = inRange(view.group);
  }

  /** Fade the world in — held black until the camera sits on the local trogg, so a
   *  slow first snapshot never shows the zone-centre framing at all. */
  private reveal(): void {
    document.getElementById("boot-screen")?.remove();
    const canvas = this.renderer.domElement;
    canvas.style.transition = "opacity 0.35s ease-out";
    canvas.style.opacity = "1";
  }
  private readonly groundItems = new Map<string, { row: GroundItem; group: THREE.Group }>();
  private readonly hogs = new Map<string, HogView>();

  private readonly boulderTiles = new Set<string>();
  private readonly treeTiles = new Set<string>();
  private readonly hogTiles = new Set<string>();
  private keyLight!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.Sprite;
  private moon!: THREE.Sprite;

  /** A glowing disc billboard for the sun and moon. */
  private static skyBody(colour: string, size: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    const glow = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
    glow.addColorStop(0, colour);
    glow.addColorStop(0.35, colour);
    glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, fog: false, depthWrite: false }));
    sprite.scale.setScalar(size);
    return sprite;
  }
  private readonly skyDay = new THREE.Color(DAYLIGHT_3D.sky);
  private readonly skyNight = new THREE.Color(0x0d1424);
  private readonly hazeDay = new THREE.Color(DAYLIGHT_3D.haze);
  private readonly hazeNight = new THREE.Color(0x101a2c);

  /** The Commands drawer's sky lock: a fixed day phase for this client's
   *  rendering only (the cycle is cosmetic, nothing authoritative reads it). */
  private dayPhaseOverride?: number;

  /** The shared day–night cycle: wall-clock phased (every player sees the same
   *  sun), the sun arcs east→west shifting the shadows with it, and night falls
   *  to a dim moonlit blue where the glowmoss carries the light. */
  private updateDaylight(): void {
    if (!this.orbit) return;
    const phase = this.dayPhaseOverride ?? (Date.now() % DAY_CYCLE_MS) / DAY_CYCLE_MS; // 0 = dawn
    const sunAngle = phase * Math.PI * 2 - Math.PI / 2;
    const elevation = Math.sin(sunAngle + Math.PI / 2); // 1 noon, -1 midnight
    const daylight = Math.max(0, Math.min(1, (elevation + 0.12) * 2.4));
    const fx = this.orbit.target.x;
    const fz = this.orbit.target.z;
    // the sun arcs across the sky; at night it parks low so shadows fade with it
    this.keyLight.position.set(fx + Math.cos(sunAngle) * 30, 8 + Math.max(0.05, elevation) * 26, fz + Math.sin(sunAngle) * 14 + 8);
    this.keyLight.target.position.set(fx, 0, fz);
    this.keyLight.intensity = 3.2 * daylight;
    this.hemi.intensity = 0.3 + 1.2 * daylight;
    // the sun you can actually look up at, and the moon opposite it
    this.sun.position.set(fx + Math.cos(sunAngle) * 85, Math.max(-20, elevation * 70), fz + Math.sin(sunAngle) * 40 + 8);
    this.sun.visible = elevation > -0.08;
    this.moon.position.set(fx - Math.cos(sunAngle) * 85, Math.max(-20, -elevation * 70), fz - Math.sin(sunAngle) * 40 + 8);
    this.moon.visible = elevation < 0.08;
    (this.scene.background as THREE.Color).lerpColors(this.skyNight, this.skyDay, daylight);
    (this.scene.fog as THREE.Fog).color.lerpColors(this.hazeNight, this.hazeDay, daylight);
  }
  private selfPos?: { x: number; y: number };
  private hogBounds!: ZoneBounds;
  private troggBounds!: ZoneBounds;

  private destinationTile?: Coord;
  private readonly sub = { live: false };
  private lastMs = performance.now();
  private lastFrameMs = 0;
  /** The raw screen-space WASD intent and its last camera-mapped delivery, so the
   *  tick can re-steer a held walk when the camera turns. */
  private rawIntent: MoveIntent = { dirX: 0, dirY: 0, running: false };
  private lastMapped: MoveIntent = { dirX: 0, dirY: 0, running: false };

  private useHogs = false;
  private useGhost = false;
  private canRun = false;
  private useInteract = false;

  /** Held lift input (Space climbs, C sinks) and the last vertical intent sent —
   *  lift is synced like any other input transition (`setLift`), so altitude is
   *  derived identically on every client and the server. */
  private flySpaceHeld = false;
  private flySinkHeld = false;
  private sentLift = 0;

  constructor(parent: HTMLElement, data: WorldData) {
    this.conn = data.conn;
    this.slug = data.slug;
    this.zone = getZone(data.slug) ?? getZone(STARTING_ZONE_SLUG)!;
    this.parent = parent;
    // No preserveDrawingBuffer: it forces a framebuffer copy every frame on
    // tile-based GPUs (Apple); probes screenshot via the compositor instead.
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
  }

  start(): void {
    const conn = this.conn;
    this.myId = conn.identity?.toHexString();
    this.parent.appendChild(this.renderer.domElement);
    this.mountVignette();

    this.useHogs = isFeatureEnabled("roaming-hogs");
    this.useGhost = isFeatureEnabled("ghost-trogg");
    this.canRun = isFeatureEnabled("running");
    this.useInteract = isFeatureEnabled("interact");
    logInfo("World scene created", {
      zone: this.slug,
      renderer: "three",
      roaming_hogs: this.useHogs,
      ghost_trogg: this.useGhost,
      running: this.canRun,
      interact: this.useInteract,
    });

    // mirrors the server: water blocks a Hog like a boulder or tree (GDD "Zones")
    const obstructed = (x: number, y: number) => this.boulderTiles.has(tileKey(x, y)) || this.treeTiles.has(tileKey(x, y));
    this.hogBounds = zoneBounds(this.zone, (x, y) => obstructed(x, y) || !isDryFloor(this.zone, x, y));
    this.troggBounds = zoneBounds(this.zone, (x, y) => obstructed(x, y) || this.hogTiles.has(tileKey(x, y)));

    // Torch-lit cave: dim warm ambient, one shadowing key light, dark fog closing in
    // past the zone. Glowmoss tiles add their own teal point lights (terrain3d).
    // Daylight: the continent lives under a sun (GDD "Camera and rendering") —
    // sky backdrop, aerial haze, bright warm sunlight with a cool sky bounce.
    // The sun travels a shared day–night cycle (updateDaylight, wall-clock based
    // so every player sees the same time of day).
    this.scene.background = new THREE.Color(DAYLIGHT_3D.sky);
    // a faint depth haze only — the zoom is capped, so there is no fog of war
    this.scene.fog = new THREE.Fog(DAYLIGHT_3D.haze, 60, 150);
    this.hemi = new THREE.HemisphereLight(0xdcebff, DAYLIGHT_3D.bounce, 1.5);
    this.scene.add(this.hemi);
    // The sun rides the camera focus with a tight shadow box — a static light
    // can't shadow a 224×208 world at any usable resolution.
    const key = new THREE.DirectionalLight(DAYLIGHT_3D.sun, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -56;
    key.shadow.camera.right = 56;
    key.shadow.camera.top = 56;
    key.shadow.camera.bottom = -56;
    this.scene.add(key, key.target);
    this.keyLight = key;
    this.sun = World3D.skyBody("rgba(255, 236, 190, 1)", 16);
    this.moon = World3D.skyBody("rgba(214, 226, 248, 0.85)", 9);
    this.scene.add(this.sun, this.moon);

    this.terrain = buildTerrain(this.zone);
    this.scene.add(this.terrain.group);
    this.entities = createEntities(this.scene);
    this.treeField = new NodeField(this.scene, buildTree(), MAX_TREES_PER_ZONE);
    this.boulderField = new NodeField(this.scene, buildBoulder(), MAX_BOULDERS_PER_ZONE);
    this.crowd = new FarCrowd(this.scene);

    // The click-to-move destination marker: a flat gold-edged tile highlight.
    this.destination = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.8),
      new THREE.MeshBasicMaterial({ color: UI_3D.gold, transparent: true, opacity: 0.28 }),
    );
    this.destination.rotation.x = -Math.PI / 2;
    this.destination.position.y = 0.02;
    this.destination.visible = false;
    this.scene.add(this.destination);

    this.self = createSelfController({
      conn,
      bounds: this.troggBounds,
      getSelf: () => (this.myId ? this.tracked.get(this.myId) : undefined),
      showDestination: (tile) => {
        this.destinationTile = tile;
        this.drawDestination();
      },
      toBaseMs: timestampBaseMs,
      facingFromDir,
      // a flying trogg's feet never land, so its stride makes no sound
      audio: { ...audio, playFootstep: (running: boolean) => { if (!this.selfFlying()) audio.playFootstep(running); } },
    });

    this.wirePlayers();
    this.wireGroundItems();
    this.wireBoulders();
    this.wireTrees();
    if (this.useHogs) this.wireHogs();
    if (this.useGhost) this.wireGhostHaunts();

    attachKeyboard(
      (intent, immediate) => {
        if (this.myId && this.tracked.get(this.myId)?.player.dead) return;
        this.rawIntent = intent;
        this.lastMapped = this.mapIntent(intent);
        this.self.onIntent(this.lastMapped, immediate);
      },
      () => {
        if (!this.useInteract) return;
        void interact(conn, this.self.facing.dirX, this.self.facing.dirY).catch((err) => {
          logError("Interact action failed", { surface: "world", action: "interact", zone: this.slug, error: err });
        });
      },
      () => {
        void useEquipped(conn, this.self.aim.dirX, this.self.aim.dirY).catch((err) => {
          logError("Use equipped action failed", { surface: "world", action: "use_equipped", zone: this.slug, error: err });
        });
      },
      this.canRun,
    );

    // Click-to-move: cast the pointer through the camera onto the floor plane and
    // walk to that tile. HUD panels consume their own clicks (pointer-events), so
    // only open-space clicks reach the canvas. Dragging orbits the camera instead,
    // so a click only moves when the pointer barely travelled between down and up —
    // measured as accumulated movement, since under the drag's pointer lock the
    // cursor coordinates freeze (controls).
    const ray = new THREE.Raycaster();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let pressed = false;
    let travelled = 0;
    this.renderer.domElement.addEventListener("pointerdown", () => {
      pressed = true;
      travelled = 0;
    });
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      if (pressed) travelled += Math.abs(e.movementX) + Math.abs(e.movementY);
    });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      const wasClick = pressed && travelled <= CLICK_SLOP_PX;
      pressed = false;
      if (!wasClick) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(floorPlane, hit)) return;
      const x = Math.floor(hit.x);
      const y = Math.floor(hit.z);
      if (x < 0 || y < 0 || x >= this.zone.width || y >= this.zone.height) return;
      if (this.myId && this.tracked.get(this.myId)?.player.dead) return;
      this.self.onClick({ x, y });
    });

    window.addEventListener("resize", this.layout);
    this.renderer.domElement.style.opacity = "0";
    // if the snapshot stalls (or this session never gets a trogg), show the zone
    window.setTimeout(() => this.reveal(), 4000);
    // Commands-panel debug: show combat hit circles and the local melee reach.
    window.addEventListener("trogg-debug-hitboxes", ((e: Event) => {
      this.entities.setHitboxes((e as CustomEvent<boolean>).detail === true);
    }) as EventListener);
    // Commands-drawer sky lock: a number locks this client's day phase, null
    // hands the sky back to the shared wall clock.
    window.addEventListener("trogg-debug-daylight", ((e: Event) => {
      const phase = (e as CustomEvent<number | null>).detail;
      this.dayPhaseOverride = typeof phase === "number" ? Math.min(1, Math.max(0, phase)) : undefined;
    }) as EventListener);
    // Fly cheat lift: hold Space to climb, C to sink. Key transitions send a
    // synced vertical intent (`setLift` — the move reducer's third axis), so
    // every client derives the same altitude. keyup always clears, so a hold
    // that ends over the chat input can't stick.
    const sendLift = () => {
      const lift = (this.flySpaceHeld ? 1 : 0) - (this.flySinkHeld ? 1 : 0);
      if (lift === this.sentLift || !this.selfFlying()) return;
      this.sentLift = lift;
      void conn.reducers.setLift({ dirZ: lift }).catch((err) => {
        logError("Lift intent failed", { surface: "world", action: "set_lift", zone: this.slug, error: err });
      });
    };
    window.addEventListener("keydown", (e) => {
      if (isTyping(e.target)) return;
      if (e.code === "Space") {
        if (this.selfFlying()) e.preventDefault();
        if (!this.flySpaceHeld) {
          this.flySpaceHeld = true;
          sendLift();
        }
      } else if (e.code === "KeyC") {
        if (!this.flySinkHeld) {
          this.flySinkHeld = true;
          sendLift();
        }
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this.flySpaceHeld = false;
        sendLift();
      } else if (e.code === "KeyC") {
        this.flySinkHeld = false;
        sendLift();
      }
    });
    this.layout();

    if (isFeatureEnabled("chat-enabled")) {
      setupChat(conn, { showBubble: (id, text) => this.showBubble(id, text) }, this.zone, this.sub, this.myId);
    }
    mountCommands({ conn, zone: this.zone });

    const queries = [
      `SELECT * FROM player WHERE zone_id = '${this.slug}' AND online = true`,
      `SELECT * FROM chat_message WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM ground_item WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM boulder WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM tree WHERE zone_id = '${this.slug}'`,
    ];
    if (this.myId) queries.push(`SELECT * FROM inventory WHERE player_id = '${this.myId}'`);
    if (this.useHogs) queries.push(`SELECT * FROM hog WHERE zone_id = '${this.slug}'`);
    if (this.useGhost) queries.push(`SELECT * FROM ghost_haunt WHERE zone_id = '${this.slug}'`);

    conn
      .subscriptionBuilder()
      .onApplied(() => {
        this.sub.live = true;
      })
      .subscribe(queries);

    this.renderer.setAnimationLoop(this.tick);
  }

  private showBubble(id: string, text: string): void {
    const entry = this.tracked.get(id);
    if (entry) this.entities.showBubble(entry, text, CHAT_BUBBLE_MS);
  }

  /** Per-frame extrapolation: positions are projected locally from each row's
   *  intent — never per-frame synced (invariant 2). */
  private readonly tick = () => {
    const now = performance.now();
    // the -1.5ms slack keeps a plain 60Hz display's ~16.7ms frames passing
    if (now - this.lastFrameMs < 1000 / FRAME_CAP_FPS - 1.5) return;
    this.lastFrameMs = now;
    const dt = Math.min(0.1, (now - this.lastMs) / 1000);
    this.lastMs = now;

    // Hogs first, so trogg collision this frame sees where the Hogs actually are.
    this.hogTiles.clear();
    this.crowd.begin();
    for (const view of this.hogs.values()) {
      const size = hogSize(view.style);
      const motion = projectMotionState({ ...view.row, size }, now - view.baseMs, this.hogBounds);
      this.entities.smoothPlace(view, motion.x, motion.y, dt);
      // a corpse lies where it fell: no gait, no patter, and no collision
      if (view.row.health <= 0) continue;
      // hidden creatures (budgeted out or out of range) skip their animation
      // mixers — position, collision, and sound still derive above; a moving
      // silhouette stands in so a zoomed-out world still looks inhabited
      if (view.marker.visible) this.entities.animateHog(view, now, dt, motion);
      else this.crowd.add("hog", motion.x, motion.y, Math.atan2(motion.dirX, motion.dirY), size, view.style);
      const tile = snapToTile({ x: motion.x, y: motion.y });
      const stepKey = tileKey(tile.x, tile.y);
      if (view.lastStepTile !== undefined && view.lastStepTile !== stepKey) {
        audio.playHogStepAt(this.hearingDistance(motion.x, motion.y), size);
      }
      view.lastStepTile = stepKey;
      for (const t of footprintTiles(tile.x, tile.y, size)) this.hogTiles.add(tileKey(t.x, t.y));
    }

    for (const entry of this.tracked.values()) {
      const isSelf = entry.player.identity.toHexString() === this.myId;
      const motion = projectMotionState(entry.player, now - entry.baseMs, this.troggBounds);
      this.entities.smoothPlace(entry, motion.x, motion.y, dt);
      // Altitude is derived from the synced intent like x/y, so every client
      // (and the flyer itself) renders the same height.
      entry.marker.position.y = motion.z;
      if (entry.marker.visible) this.entities.animate(entry, now, dt, motion);
      else if (!entry.player.dead) this.crowd.add("trogg", motion.x, motion.y, Math.atan2(motion.dirX, motion.dirY), 1, entry.style, entry.baseColor);

      if (!isSelf) {
        const stepKey = tileKey(Math.round(motion.x), Math.round(motion.y));
        if (entry.lastStepTile !== undefined && entry.lastStepTile !== stepKey && !entry.player.cheatFly) {
          audio.playFootstepAt(entry.player.running, this.hearingDistance(motion.x, motion.y));
        }
        entry.lastStepTile = stepKey;
        continue;
      }
      // The camera rides the local trogg: the orbit pivot glides to its position, so
      // drag-to-rotate and wheel-zoom stay live while walking (dead or alive — you
      // keep your camera while waiting to respawn). The very first sight of the
      // trogg snaps instead — the pivot starts at the zone centre, and gliding
      // from there reads as a swoop across the map on load.
      if (this.orbit) {
        // the pivot rides the flyer's altitude, so the camera climbs with you
        const pivot = new THREE.Vector3(motion.x + 0.5, 0.6 + motion.z, motion.y + 0.5);
        const camDist = this.camera.position.distanceTo(this.orbit.target);
        // stream terrain around the camera focus (only once the camera sits on the
        // trogg — the pre-snap zone-fit distance would build the whole world)
        if (this.cameraSnapped) this.terrain.update(this.orbit.target.x, this.orbit.target.z, camDist);
        this.cullDistant(CULL_RANGE);
        this.updateDaylight();
        // backstop: never let the camera sink underground (drags handle the floor
        // — and the sky look-up — in controls.ts; this catches everything else)
        if (this.camera.position.y < 0.5) this.camera.position.y = 0.5;
        const ease = this.cameraSnapped ? Math.min(1, dt * 8) : 1;
        const shift = pivot.sub(this.orbit.target).multiplyScalar(ease);
        this.orbit.target.add(shift);
        this.camera.position.add(shift); // carry the camera with the pivot so following doesn't re-aim the view
        if (!this.cameraSnapped) {
          this.cameraSnapped = true;
          // open BEHIND the trogg at shoulder height (a chase view, not top-down):
          // the world reads at its own scale from the first frame
          const aim = this.self.aim;
          const back = Math.hypot(aim.dirX, aim.dirY) || 1;
          this.camera.position.set(this.orbit.target.x - (aim.dirX / back) * 7.5, 3.6, this.orbit.target.z - (aim.dirY / back) * 7.5);
          this.camera.lookAt(this.orbit.target);
          this.reveal();
        }
      }
      if (entry.player.dead) continue;
      this.self.update(entry, motion, now);
      const attackAge = entry.equipmentActionBaseMs === undefined ? -1 : now - entry.equipmentActionBaseMs;
      this.entities.updateReach(this.self.aim.dirX, this.self.aim.dirY, attackAge >= 0 && attackAge < EQUIPMENT_ACTION_MS && entry.player.equipmentAction !== "");
      // Exposed for the e2e harness: the local trogg's projected tile position and
      // a click-to-move injection, so probes can route with the real pathfinding.
      this.selfPos = { x: motion.x, y: motion.y };
      const hooks = window as unknown as {
        __troggPos?: { x: number; y: number };
        __troggMoveTo?: (x: number, y: number) => void;
        __renderInfo?: () => { calls: number; triangles: number };
      };
      hooks.__troggPos = this.selfPos;
      hooks.__troggMoveTo ??= (x: number, y: number) => this.self.onClick({ x, y });
      hooks.__renderInfo ??= () => {
        let troggMeshes = 0;
        let visibleTroggs = 0;
        for (const t of this.tracked.values()) {
          if (!t.marker.visible) continue;
          visibleTroggs++;
          t.marker.traverse(() => troggMeshes++);
        }
        let sceneObjects = 0;
        let totalObjects = 0;
        this.scene.traverse((o) => {
          totalObjects++;
          if (o.visible) sceneObjects++;
        });
        const info = this.renderer.info;
        return {
          frame: info.render.frame,
          calls: info.render.calls,
          triangles: info.render.triangles,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
          visibleTroggs,
          troggMeshes,
          sceneObjects,
          totalObjects,
          hogs: this.hogs.size,
          trees: this.trees.size,
          boulders: this.boulders.size,
          groundItems: this.groundItems.size,
        };
      };
    }

    // A held key steers relative to the camera: while the orbit turns, re-map the
    // raw intent and re-deliver when the world heading actually changed (the 15°
    // quantisation keeps this to real turns, not damping jitter).
    if (this.rawIntent.dirX !== 0 || this.rawIntent.dirY !== 0) {
      const mapped = this.mapIntent(this.rawIntent);
      if (mapped.dirX !== this.lastMapped.dirX || mapped.dirY !== this.lastMapped.dirY) {
        this.lastMapped = mapped;
        this.self.onIntent(mapped);
      }
    }

    // the pickup sparkle over every ground item — driven unconditionally (a few
    // hundred 4-vertex buffers is nothing), so it can never stall on cull state
    for (const view of this.groundItems.values()) {
      this.entities.animatePickupMotes(view.group, now);
    }
    this.crowd.commit();
    this.entities.updateGhosts(now);
    this.orbit?.update();
    this.renderer.render(this.scene, this.camera);
  };

  private drawDestination(): void {
    if (!this.destinationTile) {
      this.destination.visible = false;
      return;
    }
    this.destination.position.set(this.destinationTile.x + 0.5, 0.02, this.destinationTile.y + 0.5);
    this.destination.visible = true;
  }

  /** Size the viewport; on the first pass, fit the whole zone at the 3/4 angle
   *  (walk the camera back along its start direction until every zone corner
   *  projects inside the ZONE_FILL frame) and hand the camera to the mouse orbit —
   *  drag rotates around the zone, wheel zooms, clamped so the cave stays in view. */
  private readonly layout = () => {
    const w = this.parent.clientWidth || window.innerWidth;
    const h = this.parent.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.orbit) return;

    const centre = new THREE.Vector3(this.zone.width / 2, 0, this.zone.height / 2);
    const corners = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(this.zone.width, 0, 0),
      new THREE.Vector3(0, 0.9, this.zone.height),
      new THREE.Vector3(this.zone.width, 0.9, this.zone.height),
      new THREE.Vector3(this.zone.width / 2, 2, 0),
    ];
    const fits = (d: number): boolean => {
      this.camera.position.copy(centre).addScaledVector(CAMERA_DIR, d);
      this.camera.lookAt(centre);
      this.camera.updateMatrixWorld();
      return corners.every((c) => {
        const p = c.clone().project(this.camera);
        return Math.abs(p.x) <= ZONE_FILL && Math.abs(p.y) <= ZONE_FILL;
      });
    };
    let lo = 4;
    let hi = 110;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    fits(hi);

    this.orbit = createOrbit(this.camera, this.renderer.domElement);
    this.orbit.target.copy(centre);
    this.orbit.minDistance = 6;
    this.orbit.maxDistance = 34; // zoom is capped; the M map is the wide view
    this.orbit.minPolarAngle = 0.25; // not dead top-down; locked drags go past
    this.orbit.maxPolarAngle = 2.05; // horizontal and pitch up at the sky (controls.ts)
    this.orbit.update();
  };

  /** Map a WASD intent from screen space to world space by the camera's heading:
   *  W walks where the camera looks, A/D strafe, S backs up. The heading quantises
   *  to 15° buckets (so orbit damping doesn't spam re-sends) and the result rides
   *  the DIR_SCALE integer wire format. `tick` re-maps while keys are held, so
   *  turning the camera mid-walk curves the walk with it. */
  private mapIntent(intent: MoveIntent): MoveIntent {
    if (!this.orbit || (intent.dirX === 0 && intent.dirY === 0)) return { ...intent };
    const bucket = Math.PI / 12;
    const a = -Math.round(this.orbit.getAzimuthalAngle() / bucket) * bucket;
    const wx = intent.dirX * Math.cos(a) - intent.dirY * Math.sin(a);
    const wy = intent.dirX * Math.sin(a) + intent.dirY * Math.cos(a);
    const len = Math.hypot(wx, wy) || 1;
    return { dirX: Math.round((wx / len) * DIR_SCALE), dirY: Math.round((wy / len) * DIR_SCALE), running: intent.running };
  }

  /** A soft radial darkening over the whole viewport — the cave vignette. */
  private mountVignette(): void {
    const v = document.createElement("div");
    v.style.cssText = "position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0,0.55) 100%)";
    this.parent.appendChild(v);
  }

  private rebuildMarker(id: string, entry: Tracked): void {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    this.entities.destroy(entry);
    entry.style = troggStyleFor(entry.player.style, id);
    entry.baseColor = troggColorFor(entry.player.color, id);
    const built = this.entities.makeMarker(entry.player.name, entry.baseColor, entry.style, id === this.myId, entry.facing, entry.player.health, entry.player.dead, entry.player.respawnAt);
    entry.marker = built.marker;
    entry.model = built.model;
    entry.overlays = built.overlays;
    entry.respawn = built.respawn;
    entry.gait = "idle";
    entry.attacking = undefined;
    entry.attackingBaseMs = undefined;
    entry.flashOn = false;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    entry.carried = undefined;
    entry.carriedKind = "";
    entry.carriedStyle = "";
    entry.equip = {};
    entry.equipmentActionBaseMs = undefined;
    const { x, y } = projectMotion(entry.player, performance.now() - entry.baseMs, this.troggBounds);
    this.entities.place(entry.marker, x, y);
    this.scene.add(entry.marker);
    this.entities.applyCarry(entry);
    this.entities.applyEquipment(entry);
  }

  private wirePlayers(): void {
    const conn = this.conn;
    conn.db.player.onInsert((_ctx, p) => this.addPlayer(p));
    conn.db.player.onUpdate((_ctx, _old, p) => {
      const id = p.identity.toHexString();
      const entry = this.tracked.get(id);
      if (!entry) return this.addPlayer(p);

      if (id === this.myId) {
        this.observeLocalLifecycle(_old, p);
        this.self.reconcile(entry, p);
      } else {
        const motionChanged = playerMotionChanged(entry.player, p);
        const staleMotion = motionChanged && isOlderPlayerMotion(p, entry.player);
        entry.player = staleMotion ? withPlayerMotion(p, entry.player) : p;
        // Rebase extrapolation to the server's movedAt on the local monotonic clock,
        // not receipt time, so a deployed client doesn't trail the server by its
        // network latency. Non-motion updates keep the base so walking doesn't restart.
        if (motionChanged && !staleMotion) entry.baseMs = timestampBaseMs(p.movedAt);
      }

      if (_old.equipmentActionAt.microsSinceUnixEpoch !== p.equipmentActionAt.microsSinceUnixEpoch) {
        entry.equipmentActionBaseMs = performance.now();
      }
      if (p.health < _old.health) {
        if (!p.dead) entry.flinchBaseMs = performance.now();
        this.entities.showDamage(entry.marker.position, _old.health - p.health, this.entities.headTop());
      }

      // The nameplate, tint, body style, and health bar are baked into the marker;
      // those changes rebuild it. Bare carrying/equipment changes retarget overlays.
      if (_old.name !== p.name || _old.color !== p.color || _old.style !== p.style || _old.health !== p.health || _old.dead !== p.dead || _old.respawnAt !== p.respawnAt) this.rebuildMarker(id, entry);
      else if (_old.carrying !== p.carrying || _old.carryingStyle !== p.carryingStyle) this.entities.applyCarry(entry);

      const equipmentChanged =
        _old.equippedMainHand !== p.equippedMainHand ||
        _old.equippedMainHandInventoryId !== p.equippedMainHandInventoryId ||
        _old.equippedOffHand !== p.equippedOffHand ||
        _old.equippedOffHandInventoryId !== p.equippedOffHandInventoryId;
      if (equipmentChanged) this.entities.applyEquipment(entry);
    });
    conn.db.player.onDelete((_ctx, p) => this.removePlayer(p.identity.toHexString()));
  }

  private observeLocalLifecycle(old: Player, p: Player): void {
    if (!old.dead && p.dead) {
      logInfo("Local player died", { surface: "world", action: "player_died", zone: p.zoneId, respawn_ms: PLAYER_RESPAWN_MS });
    } else if (old.dead && !p.dead) {
      captureEvent("player_respawned", { zone: p.zoneId, respawn_ms: PLAYER_RESPAWN_MS, source: "player-row-sync" });
      logInfo("Local player respawned", { surface: "world", action: "player_respawned", zone: p.zoneId, respawn_ms: PLAYER_RESPAWN_MS });
    }
  }

  private addPlayer(p: Player): void {
    const id = p.identity.toHexString();
    if (this.tracked.has(id)) return;
    const face = playerFacing(p);
    const facing = facingFromDir(face.dirX, face.dirY, "down");
    const style = troggStyleFor(p.style, id);
    const color = troggColorFor(p.color, id);
    const built = this.entities.makeMarker(p.name, color, style, id === this.myId, facing, p.health, p.dead, p.respawnAt);
    const entry: Tracked = {
      marker: built.marker,
      model: built.model,
      overlays: built.overlays,
      respawn: built.respawn,
      player: p,
      baseMs: timestampBaseMs(p.movedAt),
      facing,
      style,
      baseColor: color,
      gait: "idle",
      attacking: undefined,
      flashOn: false,
      corrX: 0,
      corrY: 0,
      carriedKind: "",
      carriedStyle: "",
      equip: {},
    };
    const { x, y } = projectMotion(p, performance.now() - entry.baseMs, this.troggBounds);
    this.entities.place(entry.marker, x, y);
    this.tracked.set(id, entry);
    this.scene.add(entry.marker);
    this.entities.applyCarry(entry);
    this.entities.applyEquipment(entry);
  }

  private removePlayer(id: string): void {
    const entry = this.tracked.get(id);
    if (entry) this.entities.destroy(entry);
    this.tracked.delete(id);
  }

  private syncBoulderTiles(): void {
    this.boulderTiles.clear();
    for (const b of this.boulders.values()) this.boulderTiles.add(tileKey(b.x, b.y));
  }

  private syncTreeTiles(): void {
    this.treeTiles.clear();
    for (const t of this.trees.values()) this.treeTiles.add(tileKey(t.x, t.y));
  }

  private upsertTree(row: Tree): void {
    const key = row.id.toString();
    this.trees.set(key, row);
    this.treeField.set(key, row.x, row.y);
    this.syncTreeTiles();
  }

  private removeTree(row: Tree): void {
    const key = row.id.toString();
    this.treeField.remove(key);
    this.trees.delete(key);
    this.syncTreeTiles();
    // a felled tree crashes down nearby — the settle hit doubles as the fall
    if (this.sub.live) audio.playBoulderSettleAt(this.hearingDistance(row.x + 0.5, row.y + 0.5));
  }

  private wireTrees(): void {
    const conn = this.conn;
    conn.db.tree.onInsert((_ctx, row) => this.upsertTree(row));
    conn.db.tree.onUpdate((_ctx, _old, row) => {
      if (row.health < _old.health) this.nodeHit(this.treeField, row, _old.health - row.health, 1.9);
      this.upsertTree(row);
    });
    conn.db.tree.onDelete((_ctx, row) => {
      // a full-health delete is a reset/heal wipe, not the felling blow
      if (row.health < TREE_MAX_HEALTH) this.nodeHit(this.treeField, row, row.health, 1.9);
      this.removeTree(row);
    });
  }

  private upsertBoulder(b: Boulder): void {
    const key = b.id.toString();
    this.boulders.set(key, b);
    this.boulderField.set(key, b.x, b.y);
    this.syncBoulderTiles();
  }

  private removeBoulder(b: Boulder): void {
    const key = b.id.toString();
    this.boulderField.remove(key);
    this.boulders.delete(key);
    this.syncBoulderTiles();
  }

  /** A tool swing landed on a gathering node: white pop + a floating damage
   *  number, exactly the feedback a creature hit gives (GDD "Boulders and trees").
   *  The breaking hit arrives as a delete; the row's remaining health is the
   *  damage that swing effectively dealt. */
  private nodeHit(field: NodeField, row: { id: bigint; x: number; y: number }, amount: number, headY: number): void {
    if (!this.sub.live) return;
    field.flash(row.id.toString());
    this.entities.showDamage({ x: row.x, z: row.y }, amount, headY);
  }

  private wireBoulders(): void {
    const conn = this.conn;
    conn.db.boulder.onInsert((_ctx, b) => this.upsertBoulder(b));
    conn.db.boulder.onUpdate((_ctx, _old, b) => {
      if (this.sub.live && (_old.x !== b.x || _old.y !== b.y)) audio.playBoulderSettleAt(this.hearingDistance(b.x + 0.5, b.y + 0.5));
      if (b.health < _old.health) this.nodeHit(this.boulderField, b, _old.health - b.health, 0.85);
      this.upsertBoulder(b);
    });
    conn.db.boulder.onDelete((_ctx, b) => {
      // a full-health delete is a reset/heal wipe, not a mining blow
      if (b.health < BOULDER_MAX_HEALTH) this.nodeHit(this.boulderField, b, b.health, 0.85);
      this.removeBoulder(b);
    });
  }

  private upsertGroundItem(row: GroundItem): void {
    const key = row.id.toString();
    let view = this.groundItems.get(key);
    if (!view) {
      view = { row, group: this.entities.makeGroundItem(row.item) };
      this.groundItems.set(key, view);
      this.scene.add(view.group);
    } else if (view.row.item !== row.item) {
      disposeObject(view.group);
      view.group = this.entities.makeGroundItem(row.item);
      this.scene.add(view.group);
    }
    view.row = row;
    this.entities.place(view.group, row.x, row.y);
  }

  private removeGroundItem(row: GroundItem): void {
    const view = this.groundItems.get(row.id.toString());
    if (view) disposeObject(view.group);
    this.groundItems.delete(row.id.toString());
  }

  private wireGroundItems(): void {
    const conn = this.conn;
    conn.db.groundItem.onInsert((_ctx, row) => this.upsertGroundItem(row));
    conn.db.groundItem.onUpdate((_ctx, _old, row) => this.upsertGroundItem(row));
    conn.db.groundItem.onDelete((_ctx, row) => this.removeGroundItem(row));
  }

  private addHog(h: Hog): void {
    const id = h.id.toString();
    if (this.hogs.has(id)) return;
    const facing = facingFromDir(h.dirX, h.dirY, "down");
    const style = h.style || hogStyleFor(id, h.style);
    const built = this.entities.makeHog(style, facing, h.health);
    const baseMs = timestampBaseMs(h.movedAt);
    const view: HogView = { marker: built.marker, model: built.model, overlays: built.overlays, row: h, baseMs, facing, style, gait: "idle", flashOn: false, corrX: 0, corrY: 0 };
    const { x, y } = projectMotion({ ...h, size: hogSize(style) }, performance.now() - baseMs, this.hogBounds);
    this.entities.place(view.marker, x, y);
    this.hogs.set(id, view);
    this.scene.add(view.marker);
  }

  private updateHog(h: Hog): void {
    const view = this.hogs.get(h.id.toString());
    if (!view) return this.addHog(h);
    const style = hogStyleFor(h.id.toString(), h.style);
    if (view.style !== style || view.row.health !== h.health) {
      const { x, y } = projectMotion(view.row, performance.now() - view.baseMs, this.hogBounds);
      this.entities.destroy(view);
      const built = this.entities.makeHog(style, view.facing, h.health);
      view.marker = built.marker;
      view.model = built.model;
      view.overlays = built.overlays;
      view.style = style;
      view.gait = "idle";
      view.flashOn = false;
      this.entities.place(view.marker, x, y);
      this.scene.add(view.marker);
    }
    view.row = h;
    view.baseMs = timestampBaseMs(h.movedAt);
  }

  private removeHog(h: Hog): void {
    const view = this.hogs.get(h.id.toString());
    if (view) this.entities.destroy(view);
    this.hogs.delete(h.id.toString());
  }

  private wireHogs(): void {
    const conn = this.conn;
    conn.db.hog.onInsert((_ctx, h) => this.addHog(h));
    conn.db.hog.onUpdate((_ctx, _old, h) => {
      const damaged = h.health < _old.health;
      this.updateHog(h);
      if (damaged) {
        const view = this.hogs.get(h.id.toString());
        if (view) {
          view.flinchBaseMs = performance.now();
          this.entities.showDamage(view.marker.position, _old.health - h.health, view.model.height * hogSize(view.style));
        }
      }
      if (!this.sub.live) return;
      // corpses don't snuffle (death zeroes the heading, which reads as a turn)
      const changedHeading = h.health > 0 && (_old.dirX !== h.dirX || _old.dirY !== h.dirY);
      if (changedHeading && Math.random() < 0.35) audio.playHogAt(this.hearingDistance(h.x, h.y));
    });
    conn.db.hog.onDelete((_ctx, h) => this.removeHog(h));
  }

  private wireGhostHaunts(): void {
    this.conn.db.ghostHaunt.onInsert((_ctx, haunt) => {
      // Render only fresh inserts, so a joiner doesn't replay the backlog as a swarm.
      if (Date.now() - timestampMs(haunt.createdAt) > GHOST_HAUNT_FRESH_MS) return;
      this.entities.hauntGhost({ x: haunt.x, y: haunt.y, id: haunt.id });
    });
  }
}
