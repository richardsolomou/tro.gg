import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CLICK_SLOP_PX, createOrbit } from "./controls.js";
import {
  CAVE_DOOR,
  isBirthZone,
  DARK_CREATURES,
  AFK_UNLOCK_XP,
  AFK_HIDE_AFTER_MS,
  TORCH_LIT_RADIUS,
  TORCH_PROVOKED_MS,
  DAY_CYCLE_MS,
  dayPhaseAt,
  isNightPhase,
  EQUIPMENT_ACTION_MS,
  CHAT_BUBBLE_MS,
  DIR_SCALE,
  facingFromDir,
  getZone,
  GHOST_HAUNT_FRESH_MS,
  GLOWMOSS_TILE,
  isRevealed,
  penumbraOf,
  presenceOf,
  PLAYER_RESPAWN_MS,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  MAX_TREES_PER_ZONE,
  projectMotion,
  projectMotionState,
  regionAt,
  tileGlyph,
  regionVisibility,
  rockHeightAt,
  snapToTile,
  STARTING_ZONE_SLUG,
  THROWN_FLIGHT_MAX_MS,
  thrownFlightMs,
  tileKey,
  timestampMs,
  troggColorFor,
  troggStyleFor,
  WALL_TILE,
  zoneBounds,
  type Coord,
  type RegionVisibility,
  type Presence,
  type Stamp,
  type ZoneBounds,
  type Zone,
} from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import type { Boulder, Brazier, DarkCreature, GroundItem, Player, Tree } from "../net/module_bindings/types";
import { attachKeyboard, isTyping, type MoveIntent } from "../input.js";
import { setupChat } from "../ui/chat.js";
import { coachHit } from "../ui/coach.js";
import { mountCommands } from "../ui/commands.js";
import { regionToast } from "../ui/toasts.js";
import { createSelfController, type SelfController } from "../movement.js";
import { bumpPerf, captureEvent, isFeatureEnabled, logError, logInfo } from "../analytics.js";
import { audio } from "../audio.js";
import { interact, useEquipped } from "../net/procedures.js";
import { isOlderPlayerMotion, playerMotionChanged, withPlayerMotion } from "../motion_sync.js";
import { FarCrowd } from "./crowd.js";
import { createEntities, disposeObject, FLINCH_MS, poseDead, setDowned, setPresenceDim, steer, yawFor, type Entities, type Tracked } from "./entities.js";
import { buildGrask } from "./creatures.js";
import { buildBoulder, buildBrazier, buildTree, updateHeldFx, type HeldFx } from "./items.js";
import { NodeField } from "./nodes.js";
import { makeHealthBar, type Overlay } from "./overlays.js";
import { ATTACK_PERIOD, type CreatureModel } from "./rig.js";
import { buildTerrain, type Terrain3D } from "./terrain.js";
import { biomePalette, DAYLIGHT_3D, UI_3D } from "./palette.js";

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

/** A tracked dark creature (GDD "Dark creatures"): the mirror of `Tracked` for
 *  a much simpler cast — no equipment, carrying, or appearance, just motion,
 *  a health bar, and a corpse pose. */
interface DarkCreatureView {
  row: DarkCreature;
  group: THREE.Group;
  model: CreatureModel;
  health: Overlay;
  gait: "idle" | "walk";
  baseMs: number;
  flashUntil?: number;
  downed: boolean;
  attacking?: THREE.AnimationAction;
  attackBaseMs?: number;
}

/**
 * The 3D game world (GDD "Camera and rendering"): renders the zone in Three.js and
 * runs the per-frame extrapolation loop. Movement stays intent-based — the `player`
 * table syncs origin/direction/start-time and every client extrapolates locally each
 * frame (invariant 2); all authority stays server-side (invariant 3).
 */


/** World objects beyond this many tiles from the camera focus stop rendering. */
const CULL_RANGE = 72;

/** How many troggs render at once: the nearest N within CULL_RANGE. A rig is
 *  ~20 draw calls, so an unbounded crowd is a slideshow. */
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
  /** Render-time camera occlusion: the extra upward pitch (radians) currently
   *  lifting the lens over terrain that crosses the sight line. */
  private camLift = 0;
  /** Ease-down is gated until this timestamp — refreshed on every lift, so
   *  corners flicking across the line while pathing can't pump the camera. */
  private camHoldUntilMs = 0;
  /** Throws just released by any player, waiting to be paired with the object
   *  row they spawn so the client can fly it there instead of popping it in. */
  private pendingThrows: { kind: string; from: THREE.Vector3; ms: number }[] = [];
  /** In-flight thrown objects: a ghost model arcing from thrower to landing;
   *  on arrival the real object row is placed and the ghost disposed. */
  private throwsInFlight: { ghost: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; arc: number; startMs: number; durMs: number; spin: number; land: () => void }[] = [];
  /** A threshold transfer is in flight; don't re-fire while the row updates. */
  private transferPending = false;
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

  /** Whether (x, y) sits in ground the tribe currently holds against the
   *  dark — the client mirror of the server's `isLitTile`, read off the
   *  already-subscribed brazier rows. Region-wide in the world zone: a whole
   *  region counts as lit the moment any brazier inside it is lit. */
  private isLitTileClient(x: number, y: number): boolean {
    if (this.slug !== STARTING_ZONE_SLUG) return this.anyBrazierLit;
    const slug = regionAt(x, y)?.slug;
    return slug !== undefined && this.litRegionSlugs.has(slug);
  }

  /** Lit regions, cached off the subscribed brazier rows. The creature-bounds
   *  closures probe `isLitTileClient` for every crossed tile of every creature
   *  every frame — recomputing braziers × regionAt per probe scaled with the
   *  world and showed up as main-thread hitches; braziers change rarely, so
   *  cache on their row events instead. */
  private readonly litRegionSlugs = new Set<string>();
  private anyBrazierLit = false;
  private syncLitRegions(): void {
    this.litRegionSlugs.clear();
    this.anyBrazierLit = false;
    for (const view of this.braziers.values()) {
      if (!view.row.lit) continue;
      this.anyBrazierLit = true;
      const slug = regionAt(view.row.x, view.row.y)?.slug;
      if (slug) this.litRegionSlugs.add(slug);
    }
  }

  /** The shared day phase, honouring the debug sky lock (GDD "Zones"). */
  private dayPhaseNow(): number {
    return this.dayPhaseOverride ?? dayPhaseAt(Date.now());
  }

  /** Whether (x, y) is inside a lit brazier's sanctuary ring — the only safe
   *  ground at night (GDD "Night"), mirroring the server's isSanctuaryTile. */
  private isSanctuaryTileClient(x: number, y: number): boolean {
    for (const view of this.braziers.values()) {
      if (view.row.lit && Math.hypot(view.row.x - x, view.row.y - y) <= view.row.radius) return true;
    }
    return false;
  }

  /** The ground the dark cannot enter right now (GDD "Bound by the light"):
   *  whole lit regions by day, sanctuary rings at night. */
  private isSafeTileClient(x: number, y: number): boolean {
    return isNightPhase(this.dayPhaseNow()) ? this.isSanctuaryTileClient(x, y) : this.isLitTileClient(x, y);
  }

  /** The moving pockets of carried firelight (GDD "Crafting") — the client
   *  mirror of the server's torch bounds, read live off tracked torch-bearers
   *  so a creature never renders walking through someone's light. */
  private readonly torchPockets: { x: number; y: number }[] = [];
  private inTorchlightClient(x: number, y: number): boolean {
    for (const t of this.torchPockets) {
      if (Math.hypot(t.x - x, t.y - y) <= TORCH_LIT_RADIUS) return true;
    }
    return false;
  }

  /** How far the tribe's fire has reached (GDD "Generation: only as far as
   *  the light reaches") — the client mirror of the server's `isRevealed`,
   *  read off the already-subscribed `revealed_region` rows. */
  private readonly revealedRegions = new Set<string>();
  private penumbraRegions: ReadonlySet<string> = new Set();
  /** Locked display names from `revealed_region` rows — the only place a
   *  region's player-facing name ever comes from (GDD "Generation"). */
  private readonly regionNames = new Map<string, string>();
  regionNameOf(slug: string): string | undefined {
    return this.regionNames.get(slug);
  }
  isRegionRevealed(x: number, y: number): boolean {
    return isRevealed(this.zone, this.revealedRegions, this.penumbraRegions, x, y);
  }

  /** Interior, penumbra, or unreached (GDD "Generation: only as far as the
   *  light reaches") — the fog-of-war tier terrain/worldmap rendering reads,
   *  a finer-grained sibling of `isRegionRevealed`'s plain walkable/not. */
  regionVisibilityAt(x: number, y: number): RegionVisibility {
    return regionVisibility(this.zone, this.revealedRegions, this.penumbraRegions, x, y);
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
    // Dark creatures are budgeted separately from troggs (GDD "Camera and
    // rendering") — a crowd of each kind shouldn't starve the other's rigs.
    budget([...this.darkCreatures.values()].map((view) => ({ marker: view.group })));
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
    // The fire's own shadow, budgeted to one: only the nearest lit fire
    // casts (see upsertBrazier), which is the one you're standing at.
    const fires = [...this.braziers.values()]
      .filter((view) => view.row.lit && view.fx.light)
      .sort((a, b) => dist(a.group) - dist(b.group));
    fires.forEach((view, i) => {
      view.fx.light!.castShadow = i === 0 && dist(view.group) < range;
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
  private readonly braziers = new Map<string, { row: Brazier; group: THREE.Group; fx: HeldFx; ground: THREE.Mesh }>();
  private readonly darkCreatures = new Map<string, DarkCreatureView>();
  private darkCreatureBounds!: ZoneBounds;
  private nightTideBounds!: ZoneBounds;

  private readonly boulderTiles = new Set<string>();
  private readonly treeTiles = new Set<string>();
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
  /** Deephome's unsky: near-black, blue-less rock dark. */
  private readonly caveSky = new THREE.Color(0x05060a);

  /** The shared sky lock (`world_state` row): a pinned day phase for every
   *  client — the sky is shared fiction, so a scrub changes everyone's sun. */
  private dayPhaseOverride?: number;
  /** When the local trogg first emerged into the daylight, for the dawn blend. */
  private emergedAtMs?: number;
  /** 0 = surface daylight, 1 = birth-cave dark. The instanced birth cave never
   *  sees the sun; the world always does. */
  private caveDark = 0;

  /** The shared day–night cycle: wall-clock phased (every player sees the same
   *  sun), the sun arcs east→west shifting the shadows with it, and night falls
   *  to a dim moonlit blue where the glowmoss carries the light. */
  private updateDaylight(dt: number): void {
    if (!this.orbit) return;
    // The birth cave never sees the sun: inside it the whole scene sits in
    // cave-dark — glowmoss carries the light. (Eased, though in practice the
    // zone is fixed for the page's life.)
    const target = isBirthZone(this.slug) ? 1 : 0;
    this.caveDark += (target - this.caveDark) * Math.min(1, dt * 1.4);
    const dark = this.caveDark;
    let phase = this.dayPhaseOverride ?? (Date.now() % DAY_CYCLE_MS) / DAY_CYCLE_MS; // 0 = dawn (override: the shared world_state sky lock)
    // The first dawn: for a few breaths after a newborn emerges, its OWN sky
    // blends from morning gold into the shared phase — every trogg's first
    // sight of the world is sunlit, whatever the clock says. Local-only, and
    // the shared sky lock outranks it.
    if (this.emergedAtMs !== undefined && this.dayPhaseOverride === undefined) {
      const t = (performance.now() - this.emergedAtMs) / 12_000;
      if (t >= 1) this.emergedAtMs = undefined;
      else phase = 0.16 + (phase - 0.16) * t * t;
    }
    const sunAngle = phase * Math.PI * 2 - Math.PI / 2;
    const elevation = Math.sin(sunAngle + Math.PI / 2); // 1 noon, -1 midnight
    const daylight = Math.max(0, Math.min(1, (elevation + 0.12) * 2.4));
    const fx = this.orbit.target.x;
    const fz = this.orbit.target.z;
    // The shadow box rides the focus — snapped to its own texel grid, so its
    // shadow edges hold still instead of crawling across the ground with
    // every step (the classic moving-orthographic-shadow shimmer).
    const texel = 112 / 2048;
    const sfx = Math.round(fx / texel) * texel;
    const sfz = Math.round(fz / texel) * texel;
    // the sun arcs across the sky; at night it parks low so shadows fade with it
    this.keyLight.position.set(sfx + Math.cos(sunAngle) * 30, 8 + Math.max(0.05, elevation) * 26, sfz + Math.sin(sunAngle) * 14 + 8);
    this.keyLight.target.position.set(sfx, 0, sfz);
    this.keyLight.intensity = 3.2 * daylight * (1 - dark);
    // cave-dark is dim, not blind: enough ambient to read the walls around you
    this.hemi.intensity = (0.3 + 1.2 * daylight) * (1 - dark) + 0.5 * dark;
    // The sun you can actually look up at, and the moon opposite it. Both ride
    // ON the horizon at their low points, never below it, and they dissolve
    // into the haze as they get there (atmospheric extinction): a low disc sits
    // where the far plane and chunk streaming leave nothing rendered behind it,
    // so without the fade it shines "through" what reads as distant terrain.
    const sunGlow = THREE.MathUtils.smoothstep(elevation, 0.05, 0.35) * (1 - dark);
    this.sun.position.set(fx + Math.cos(sunAngle) * 85, 4 + Math.max(0, elevation) * 66, fz + Math.sin(sunAngle) * 40 + 8);
    (this.sun.material as THREE.SpriteMaterial).opacity = sunGlow;
    this.sun.visible = sunGlow > 0.01;
    const moonGlow = THREE.MathUtils.smoothstep(-elevation, 0.05, 0.35) * (1 - dark);
    this.moon.position.set(fx - Math.cos(sunAngle) * 85, 4 + Math.max(0, -elevation) * 66, fz - Math.sin(sunAngle) * 40 + 8);
    (this.moon.material as THREE.SpriteMaterial).opacity = moonGlow;
    this.moon.visible = moonGlow > 0.01;
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.lerpColors(this.skyNight, this.skyDay, daylight).lerp(this.caveSky, dark);
    }
    const fog = this.scene.fog as THREE.Fog;
    fog.color.lerpColors(this.hazeNight, this.hazeDay, daylight).lerp(this.caveSky, dark);
    fog.near = 60 - 34 * dark;
    fog.far = 150 - 80 * dark;
  }
  private selfPos?: { x: number; y: number };
  private lastRegionSlug?: string;
  private troggBounds!: ZoneBounds;

  private destinationTile?: Coord;
  private readonly sub = { live: false };
  private lastMs = performance.now();
  private lastFrameMs = 0;
  private lastHideSweepMs = 0;
  private wasNight?: boolean;
  /** The raw screen-space WASD intent and its last camera-mapped delivery, so the
   *  tick can re-steer a held walk when the camera turns. */
  private rawIntent: MoveIntent = { dirX: 0, dirY: 0, running: false };
  private lastMapped: MoveIntent = { dirX: 0, dirY: 0, running: false };

  private useGhost = false;
  private canRun = false;
  private useInteract = false;
  private useDarkCreatures = false;

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
    // No screen-space vignette over the canvas: its bright centre is anchored
    // to the camera, not the world, so near a fire the "lit" ground reads as
    // swinging around to face wherever the player is looking.

    this.useGhost = isFeatureEnabled("ghost-trogg");
    this.canRun = isFeatureEnabled("running");
    this.useInteract = isFeatureEnabled("interact");
    this.useDarkCreatures = isFeatureEnabled("dark-creature-rendering");
    logInfo("World scene created", {
      zone: this.slug,
      renderer: "three",
      ghost_trogg: this.useGhost,
      running: this.canRun,
      interact: this.useInteract,
    });

    const obstructed = (x: number, y: number) => this.boulderTiles.has(tileKey(x, y)) || this.treeTiles.has(tileKey(x, y)) || !this.isRegionRevealed(x, y);
    this.troggBounds = zoneBounds(this.zone, obstructed);
    // A dark creature can't stand on safe ground (GDD "Dark creatures";
    // "Night") — read live off the subscribed brazier rows and the shared
    // clock. Residents keep the day boundary (whole lit regions) around the
    // clock; only the night tide gets the ring-shrunk night bounds, so dawn
    // never strands a resident inside claimed ground.
    this.darkCreatureBounds = zoneBounds(this.zone, (x, y) => obstructed(x, y) || this.isLitTileClient(x, y) || this.inTorchlightClient(x, y));
    this.nightTideBounds = zoneBounds(this.zone, (x, y) => obstructed(x, y) || this.isSafeTileClient(x, y) || this.inTorchlightClient(x, y));

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

    this.terrain = buildTerrain(this.zone, (x, y) => this.regionVisibilityAt(x, y));
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

    // Instanced birth cave: a fully enclosed dark. The way out is the long
    // 1-wide throat, and its guidance is glowmoss pools the template stamps
    // along the walk — light leading toward the exit without ever showing it.
    if (isBirthZone(this.slug)) {
      // first breath in the dark: teach the pickup verb (once ever)
      coachHit("find-pickaxe");
      // the wake-up ember: a warm hearth glow over the newborn's spot
      const cell = this.zone.cells[0];
      if (cell) {
        const ember = new THREE.PointLight(0xffa658, 4.5, 9, 1.2);
        ember.position.set(cell.x + 0.5, 1.5, cell.y + 0.5);
        this.scene.add(ember);
      }
      // The pools' light: the terrain's per-chunk glowmoss budget (two lights)
      // can't cover a whole throat of them, so every pool above the rubble plug
      // gets its own point light — the landing's a brighter one, so the walk
      // ends toward a growing glow. A private cave renders alone; half a dozen
      // small lights is nothing here.
      const plug = cell?.corridor[cell.corridor.length - 1];
      const glow = biomePalette(this.zone.biome).glowmoss;
      const exitY = this.zone.exit?.y ?? 0;
      for (let y = 0; y <= (plug?.y ?? 0); y++) {
        const row = this.zone.tiles[y] ?? "";
        for (let x = 0; x < row.length; x++) {
          if (row[x] !== GLOWMOSS_TILE) continue;
          const bright = y <= exitY;
          const light = new THREE.PointLight(glow.mid, bright ? 7 : 4, bright ? 10 : 7, 1.2);
          light.position.set(x + 0.5, 0.9, y + 0.5);
          this.scene.add(light);
        }
      }
    }
    if (!isBirthZone(this.slug)) {
      // The way back down reads as a cave mouth, not a floating dark plane:
      // a hewn rock arch — two canted jambs under a heavy lintel — frames the
      // underworld's black, with rubble spilling out over the threshold. Cut
      // from the same low-poly cloth as the terrain (GDD "Onboarding").
      const mouth = new THREE.Group();
      const rock = new THREE.MeshLambertMaterial({ color: 0x5d5648, flatShading: true });
      const dark = new THREE.MeshBasicMaterial({ color: 0x050307 });
      const opening = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.1), dark);
      opening.position.set(0, 1.05, 0.18);
      opening.rotation.y = Math.PI; // faces the approach from the coast
      const jamb = (dx: number, lean: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.5, 0.9), rock);
        m.position.set(dx, 1.15, 0.28);
        m.rotation.z = lean;
        return m;
      };
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.65, 1.0), rock);
      lintel.position.set(0.06, 2.42, 0.28);
      lintel.rotation.z = 0.055; // hand-hewn, not machined
      const rubble = [
        { x: -0.95, s: 0.16, z: -0.55, turn: 0.5 },
        { x: 0.75, s: 0.11, z: -0.8, turn: 1.1 },
        { x: 0.1, s: 0.09, z: -0.45, turn: 2.2 },
      ].map(({ x, s, z, turn }) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(s * 2.2, s, s * 1.7), rock);
        m.position.set(x, s / 2, z);
        m.rotation.y = turn;
        return m;
      });
      mouth.add(opening, jamb(-1.4, 0.05), jamb(1.45, -0.07), lintel, ...rubble);
      mouth.position.set(CAVE_DOOR.x + 0.5, 0, CAVE_DOOR.y + 0.8);
      this.scene.add(mouth);
    }
    if (!isBirthZone(this.slug) && sessionStorage.getItem("trogg-emerged") === "1") {
      sessionStorage.removeItem("trogg-emerged");
      this.emergedAtMs = performance.now();
      captureEvent("warren_emerged", { zone: this.slug });
      logInfo("Newborn emerged into the world", { surface: "world", action: "warren_emerged", zone: this.slug });
    }

    this.wirePlayers();
    this.wireGroundItems();
    this.wireBoulders();
    this.wireTrees();
    this.wireBraziers();
    this.wireRevealedRegions();
    if (this.useDarkCreatures) this.wireDarkCreatures();
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
        // If we're carrying, this F is a throw. Record the release now, from the
        // local trogg's hands, so the object row it spawns pairs with it and
        // arcs in — the row insert can arrive before the carrying-cleared update.
        const self = this.myId ? this.tracked.get(this.myId) : undefined;
        if (self && self.player.carrying !== "") {
          this.pendingThrows.push({ kind: self.player.carrying, from: self.marker.position.clone().setY(1.3), ms: performance.now() });
        }
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
      if (!this.zone.unbounded && (x < 0 || y < 0 || x >= this.zone.width || y >= this.zone.height)) return;
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
    // The shared sky lock rides the world_state singleton: locked pins the
    // phase for everyone, unlocked resumes the shared wall clock.
    const applySky = (row: { skyLocked: boolean; skyPhase: number }) => {
      this.dayPhaseOverride = row.skyLocked ? Math.min(1, Math.max(0, row.skyPhase)) : undefined;
    };
    conn.db.worldState.onInsert((_ctx, row) => applySky(row));
    conn.db.worldState.onUpdate((_ctx, _old, row) => applySky(row));
    // Fly cheat lift: hold Space to climb, C to sink. Key transitions send a
    // synced vertical intent (`setLift` — the move reducer's third axis), so
    // every client derives the same altitude. keyup always clears, so a hold
    // that ends over the chat input can't stick.
    const sendLift = () => {
      const lift = (this.flySpaceHeld ? 1 : 0) - (this.flySinkHeld ? 1 : 0);
      if (lift === this.sentLift || !this.selfFlying()) return;
      this.sentLift = lift;
      this.self.onLift(lift);
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
      // AFK troggs stay in view after disconnect (GDD "The fire
      // and the dark" → Presence), so this doesn't filter on `online`.
      `SELECT * FROM player WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM chat_message WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM ground_item WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM boulder WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM tree WHERE zone_id = '${this.slug}'`,
      `SELECT * FROM brazier WHERE zone_id = '${this.slug}'`,
      "SELECT * FROM world_state",
      "SELECT * FROM stockpile",
      "SELECT * FROM skills",
      "SELECT * FROM revealed_region",
    ];
    if (this.myId) queries.push(`SELECT * FROM inventory WHERE player_id = '${this.myId}'`);
    if (this.useGhost) queries.push(`SELECT * FROM ghost_haunt WHERE zone_id = '${this.slug}'`);
    if (this.useDarkCreatures) queries.push(`SELECT * FROM dark_creature WHERE zone_id = '${this.slug}'`);

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

    // Dusk is telegraphed world-wide (GDD "Night"): every client derives the
    // same phase from the shared clock, so the banner needs no server fanout.
    const nightNow = isNightPhase(this.dayPhaseNow());
    if (this.wasNight === undefined) this.wasNight = nightNow;
    else if (nightNow !== this.wasNight) {
      this.wasNight = nightNow;
      if (nightNow) {
        regionToast("Night is falling — the fires hold only their rings");
        coachHit("first-dusk");
      }
    }

    // A trogg can cross the week-offline mark while rendered (GDD "Presence")
    // — no row update fires for pure time passing, so sweep occasionally.
    if (now - this.lastHideSweepMs > 60_000) {
      this.lastHideSweepMs = now;
      for (const [id, entry] of this.tracked) if (this.hiddenNow(entry.player)) this.removePlayer(id);
    }

    // Refresh the torch pockets once per frame — the creature-bounds
    // closures probe them per crossed tile, so they read a flat array
    // instead of scanning the tracked map every probe. Blood over flame
    // (GDD "Crafting"): a bearer who drew a dark creature's blood in the
    // last TORCH_PROVOKED_MS carries an unwarded pocket — the server lets
    // creatures cross it, so the mirror must too or they'd visibly snap.
    this.torchPockets.length = 0;
    for (const entry of this.tracked.values()) {
      const p = entry.player;
      if (!p.online || p.dead || p.equippedOffHand !== "torch") continue;
      if (Date.now() - timestampMs(p.provokedAt) < TORCH_PROVOKED_MS) continue;
      this.torchPockets.push({ x: entry.marker.position.x, y: entry.marker.position.z });
    }

    this.crowd.begin();

    for (const entry of this.tracked.values()) {
      const isSelf = entry.player.identity.toHexString() === this.myId;
      const motion = projectMotionState(entry.player, now - entry.baseMs, this.troggBounds);
      this.entities.smoothPlace(entry, motion.x, motion.y, dt);
      // Altitude is derived from the synced intent like x/y, so every client
      // (and the flyer itself) renders the same height.
      entry.marker.position.y = motion.z;
      if (entry.marker.visible) this.entities.animate(entry, now, dt, motion);
      else if (!entry.player.dead) this.crowd.add(motion.x, motion.y, Math.atan2(motion.dirX, motion.dirY), 1, entry.style, entry.baseColor);

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
        this.updateDaylight(dt);
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
          // the world reads at its own scale from the first frame. The row's
          // facing is the truth at spawn (a newborn faces its corridor). An
          // emergence arrival instead opens high — the trogg stands in a
          // dead-end cave mouth, where a chase camera would sit inside rock,
          // and the raised shot doubles as the first look across the world.
          const face = playerFacing(entry.player);
          const aim = face.dirX !== 0 || face.dirY !== 0 ? { dirX: face.dirX, dirY: face.dirY } : this.self.aim;
          const back = Math.hypot(aim.dirX, aim.dirY) || 1;
          if (this.emergedAtMs !== undefined) {
            this.camera.position.set(this.orbit.target.x, 13, this.orbit.target.z + 7);
          } else if (isBirthZone(this.slug)) {
            // a birth opens raised and close: the trogg visibly sealed in its
            // cell (a shoulder camera here would sit inside the cell wall)
            this.camera.position.set(this.orbit.target.x, 8, this.orbit.target.z + 5.5);
          } else {
            this.camera.position.set(this.orbit.target.x - (aim.dirX / back) * 7.5, 3.6, this.orbit.target.z - (aim.dirY / back) * 7.5);
          }
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
      // The frontier has no gate or wall (GDD "Generation: only as far as the
      // light reaches") — a haze tint is the only visual cue crossing into
      // penumbra, easy to miss mid-exploration. Announce it once per region
      // entered, only when the new ground is unclaimed.
      const here = this.slug === STARTING_ZONE_SLUG ? regionAt(Math.round(motion.x), Math.round(motion.y)) : undefined;
      if (this.sub.live && here?.slug !== this.lastRegionSlug) {
        // Waking up somewhere isn't a crossing: the first observation (and
        // anything before the region rows have applied — `sub.live`) seeds
        // the current region silently, so a fresh boot at the Hearth never
        // announces "entering unnamed ground".
        const wasSomewhere = this.lastRegionSlug !== undefined;
        this.lastRegionSlug = here?.slug;
        if (wasSomewhere && here && !this.revealedRegions.has(here.slug)) {
          regionToast(`Entering ${this.regionNames.get(here.slug) ?? "unnamed ground"} — unclaimed`);
        }
      }
      // Threshold transfers (GDD "Onboarding: the Warren"): walking onto the
      // cave's exit landing emerges into the world; pushing into the alcove's
      // deep end descends into your own cave. The walk is the door — the
      // server re-verifies position either way (invariant 3).
      if (!this.transferPending) {
        const exit = this.zone.exit;
        if (isBirthZone(this.slug) && exit && Math.hypot(motion.x - exit.x, motion.y - exit.y) < 1.6) {
          this.transferPending = true;
          sessionStorage.setItem("trogg-emerged", "1");
          void this.conn.reducers.emerge({}).catch((err: unknown) => {
            logError("Emerge failed", { surface: "world", action: "emerge", zone: this.slug, error: err });
          });
        } else if (!isBirthZone(this.slug) && Math.hypot(motion.x - CAVE_DOOR.x, motion.y - CAVE_DOOR.y) < 0.9) {
          this.transferPending = true;
          void this.conn.reducers.enterCave({}).catch((err: unknown) => {
            logError("Descent failed", { surface: "world", action: "enter_cave", zone: this.slug, error: err });
          });
        }
      }
      const hooks = window as unknown as {
        __troggPos?: { x: number; y: number; z: number };
        __troggMoveTo?: (x: number, y: number) => void;
        __throwsInFlight?: () => number;
        __renderInfo?: () => { calls: number; triangles: number };
      };
      hooks.__troggPos = { ...this.selfPos, z: motion.z };
      hooks.__troggMoveTo ??= (x: number, y: number) => this.self.onClick({ x, y });
      hooks.__throwsInFlight ??= () => this.throwsInFlight.length;
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
          trees: this.trees.size,
          boulders: this.boulders.size,
          groundItems: this.groundItems.size,
          braziers: this.braziers.size,
          darkCreatures: this.darkCreatures.size,
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
    // braziers are few (the First Fire, then whatever's been claimed since), so
    // animating every lit one unconditionally costs nothing.
    for (const view of this.braziers.values()) {
      if (view.row.lit) updateHeldFx(view.fx, now);
    }
    // Dark creatures: the same intent-driven extrapolation as troggs
    // (`projectMotionState`), just driven directly rather than through the
    // heavier player `Tracked` pipeline — no equipment, carrying, or
    // appearance to reconcile, only motion, a gait, and a corpse pose.
    // The zone subscription carries every creature in the whole world zone —
    // hundreds once the frontier fills in. Anything far beyond the camera's
    // range skips projection, steering, and the mixer entirely (cheap check
    // on the raw row anchor; cullDistant already keeps them invisible).
    const focusX = this.orbit?.target.x ?? this.selfPos?.x;
    const focusY = this.orbit?.target.z ?? this.selfPos?.y;
    for (const view of this.darkCreatures.values()) {
      if (focusX !== undefined && focusY !== undefined && Math.hypot(view.row.x - focusX, view.row.y - focusY) > CULL_RANGE * 1.5) continue;
      const motion = projectMotionState(view.row, now - view.baseMs, view.row.nightborn || view.row.aggroTargetId !== "" ? this.nightTideBounds : this.darkCreatureBounds);
      this.entities.place(view.group, motion.x, motion.y);
      if (!view.downed && view.group.visible) {
        const moving = motion.dirX !== 0 || motion.dirY !== 0;
        if (moving) steer(view.model.root, yawFor(motion.dirX, motion.dirY), dt);
        const nextGait = moving ? "walk" : "idle";
        if (nextGait !== view.gait) {
          const from = view.model.actions[view.gait];
          const to = view.model.actions[nextGait];
          from.legs.fadeOut(0.12);
          to.legs.reset().fadeIn(0.12).play();
          from.arms.fadeOut(view.attacking ? 0.05 : 0.12);
          if (!view.attacking) to.arms.reset().fadeIn(0.12).play();
          view.gait = nextGait;
        }
        if (view.attacking && view.attackBaseMs !== undefined && now - view.attackBaseMs >= ATTACK_PERIOD * 1000) {
          view.attacking.fadeOut(0.1);
          view.attacking = undefined;
          view.attackBaseMs = undefined;
          view.model.actions[view.gait].arms.reset().fadeIn(0.1).play();
        }
        view.model.mixer.update(dt);
      }
      if (view.flashUntil !== undefined) {
        if (now >= view.flashUntil) {
          view.model.flash(false);
          view.flashUntil = undefined;
        } else {
          view.model.flash(true);
        }
      }
    }
    this.crowd.commit();
    this.entities.updateGhosts(now);
    this.updateThrows(now);
    this.orbit?.update();
    const restoreCamera = this.applyCameraOcclusion(dt);
    this.renderer.render(this.scene, this.camera);
    restoreCamera?.();
  };

  /** Keep the trogg in sight without touching the player's zoom: when rock
   *  crosses the trogg→camera sight line (checked against the shared height
   *  model — the very heights the walls render at), the camera rises on its
   *  orbit sphere — same radius, same azimuth, the smallest pitch lift that
   *  looks over the blocker — briskly eased up, gently eased back down.
   *  Applied to the render only and restored right after: the orbit derives
   *  its state from the camera transform and must keep seeing the pose the
   *  player chose, or the lift would stick as a drag. */
  private applyCameraOcclusion(dt: number): (() => void) | undefined {
    if (!this.orbit || !this.cameraSnapped) return undefined;
    const pivot = this.orbit.target;
    const offset = new THREE.Vector3().subVectors(this.camera.position, pivot);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    if (spherical.radius < 1e-3) return undefined;
    // the sky look-up pose deliberately aims past the target — leave it be
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    if (forward.dot(offset.normalize().negate()) < 0.99) return undefined;

    const STEP = 0.3;
    const posAt = (phi: number) =>
      new THREE.Vector3().setFromSpherical(new THREE.Spherical(spherical.radius, phi, spherical.theta)).add(pivot);
    const lineBlocked = (to: THREE.Vector3): boolean => {
      const dist = pivot.distanceTo(to);
      for (let d = STEP; d < dist; d += STEP) {
        const t = d / dist;
        const tx = Math.floor(pivot.x + (to.x - pivot.x) * t);
        const ty = Math.floor(pivot.z + (to.z - pivot.z) * t);
        if (tileGlyph(this.zone, tx, ty) !== WALL_TILE) continue;
        if (pivot.y + (to.y - pivot.y) * t < rockHeightAt(this.zone, tx, ty)) return true;
      }
      return false;
    };

    // The smallest lift that clears the line (rock has no overhangs, so more
    // lift only ever helps); best-effort near-top-down when nothing does.
    const MIN_PHI = 0.15;
    const range = Math.max(0, spherical.phi - MIN_PHI);
    let needed = 0;
    if (lineBlocked(posAt(spherical.phi))) {
      needed = range;
      for (let i = 1; i <= 16; i++) {
        const lift = (range * i) / 16;
        if (!lineBlocked(posAt(spherical.phi - lift))) {
          needed = lift;
          break;
        }
      }
    }
    // Ease both ways — briskly up when rock crosses the line, gently back
    // down, and only after the line has stayed clear for a moment: pathing
    // past wall corners blocks and clears several times a second, and without
    // the hold the camera pumps with every graze.
    if (needed > this.camLift) {
      this.camLift += (needed - this.camLift) * Math.min(1, dt * 7);
      this.camHoldUntilMs = this.lastMs + 500;
    } else if (this.lastMs >= this.camHoldUntilMs) {
      this.camLift += (needed - this.camLift) * Math.min(1, dt * 1.5);
    }
    if (this.camLift < 1e-3) {
      this.camLift = 0;
      return undefined;
    }
    const position = this.camera.position.clone();
    const quaternion = this.camera.quaternion.clone();
    this.camera.position.copy(posAt(Math.max(MIN_PHI, spherical.phi - this.camLift)));
    this.camera.lookAt(pivot);
    return () => {
      this.camera.position.copy(position);
      this.camera.quaternion.copy(quaternion);
    };
  }

  private drawDestination(): void {
    if (!this.destinationTile) {
      this.destination.visible = false;
      return;
    }
    this.destination.position.set(this.destinationTile.x + 0.5, 0.02, this.destinationTile.y + 0.5);
    this.destination.visible = true;
  }

  /** Claim the most recent still-fresh release of `kind` (a thrower's F-press or
   *  another player's carry-cleared update), returning where it left their
   *  hands, or undefined if this object wasn't thrown. */
  private takeThrowOrigin(kind: string): THREE.Vector3 | undefined {
    const cutoff = performance.now() - 1500;
    for (let i = this.pendingThrows.length - 1; i >= 0; i--) {
      const t = this.pendingThrows[i]!;
      if (t.ms >= cutoff && t.kind === kind) return this.pendingThrows.splice(i, 1)[0]!.from;
    }
    return undefined;
  }

  /** Arc `ghost` from `from` to the resting spot over `durMs`, deferring `land`
   *  (which places the real row) until it touches down. */
  private flyGhost(ghost: THREE.Object3D, from: THREE.Vector3, toX: number, toY: number, durMs: number, land: () => void): void {
    const to = new THREE.Vector3(toX, 0, toY);
    ghost.position.copy(from);
    this.scene.add(ghost);
    this.throwsInFlight.push({
      ghost,
      from,
      to,
      arc: Math.max(1, from.distanceTo(to) * 0.35), // higher lob the farther it flies
      startMs: performance.now(),
      durMs,
      spin: (Math.random() * 2 - 1) * 6,
      land,
    });
  }

  /** Advance in-flight throws: a parabolic arc with tumble; on arrival place the
   *  real object and drop the ghost. */
  private updateThrows(now: number): void {
    if (this.throwsInFlight.length === 0) return;
    // stale releases that never paired with a row (e.g. an offline put-down)
    this.pendingThrows = this.pendingThrows.filter((t) => now - t.ms < 700);
    for (let i = this.throwsInFlight.length - 1; i >= 0; i--) {
      const f = this.throwsInFlight[i]!;
      const u = Math.min(1, (now - f.startMs) / f.durMs);
      f.ghost.position.set(
        f.from.x + (f.to.x - f.from.x) * u,
        f.from.y + (f.to.y - f.from.y) * u + f.arc * 4 * u * (1 - u),
        f.from.z + (f.to.z - f.from.z) * u,
      );
      f.ghost.rotation.y += f.spin * 0.016;
      f.ghost.rotation.x += f.spin * 0.011;
      if (u >= 1) {
        disposeObject(f.ghost);
        this.throwsInFlight.splice(i, 1);
        f.land();
      }
    }
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

    // The unbounded world has no rectangle to fit; frame a fixed span around
    // the spawn instead (the orbit camera takes over from the first frame anyway).
    const spawn = this.zone.spawn ?? { x: 0, y: 0 };
    const fitW = this.zone.unbounded ? 64 : this.zone.width;
    const fitH = this.zone.unbounded ? 64 : this.zone.height;
    const fitX = this.zone.unbounded ? spawn.x - fitW / 2 : 0;
    const fitY = this.zone.unbounded ? spawn.y - fitH / 2 : 0;
    const centre = new THREE.Vector3(fitX + fitW / 2, 0, fitY + fitH / 2);
    const corners = [
      new THREE.Vector3(fitX, 0, fitY),
      new THREE.Vector3(fitX + fitW, 0, fitY),
      new THREE.Vector3(fitX, 0.9, fitY + fitH),
      new THREE.Vector3(fitX + fitW, 0.9, fitY + fitH),
      new THREE.Vector3(fitX + fitW / 2, 2, fitY),
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
  private rebuildMarker(id: string, entry: Tracked): void {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    this.entities.destroy(entry);
    entry.style = troggStyleFor(entry.player.style, id);
    entry.baseColor = troggColorFor(entry.player.color, id);
    entry.presence = this.presenceNow(entry.player);
    const built = this.entities.makeMarker(entry.player.name, entry.baseColor, entry.style, id === this.myId, entry.facing, entry.player.health, entry.player.dead, entry.presence, entry.player.respawnAt);
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
    // The boot's own-row subscription (main.ts) may have delivered rows before
    // these callbacks existed; adopt anything already cached for this zone.
    for (const p of conn.db.player.iter()) {
      if (p.zoneId === this.slug) this.addPlayer(p);
    }
    conn.db.player.onInsert((_ctx, p) => this.addPlayer(p));
    conn.db.player.onUpdate((_ctx, _old, p) => {
      bumpPerf("rows_player");
      const id = p.identity.toHexString();
      // An ineligible trogg going offline leaves the world entirely (GDD
      // "Presence" — the eligibility gate): no dim body, no tag, no tile.
      if (this.hiddenNow(p)) return this.removePlayer(id);
      const entry = this.tracked.get(id);
      if (!entry) return this.addPlayer(p);

      if (id === this.myId) {
        if (p.zoneId !== this.slug) {
          // zone transfer (emergence): reboot into the new zone; the boot
          // screen masks the swap and the arrival boot plays the first dawn
          if (isBirthZone(this.slug)) sessionStorage.setItem("trogg-emerged", "1");
          window.location.reload();
          return;
        }
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
      // Another player released a carried object (throw or put-down): remember
      // where it left their hands so the object row it spawns arcs in. (The
      // local trogg records its own throw at F-press time, before the insert.)
      if (id !== this.myId && _old.carrying !== "" && p.carrying === "" && this.sub.live) {
        this.pendingThrows.push({ kind: _old.carrying, from: entry.marker.position.clone().setY(1.3), ms: performance.now() });
      }

      if (_old.name !== p.name || _old.color !== p.color || _old.style !== p.style || _old.health !== p.health || _old.dead !== p.dead || _old.respawnAt !== p.respawnAt) this.rebuildMarker(id, entry);
      else if (_old.carrying !== p.carrying || _old.carryingStyle !== p.carryingStyle) this.entities.applyCarry(entry);

      const equipmentChanged =
        _old.equippedMainHand !== p.equippedMainHand ||
        _old.equippedMainHandInventoryId !== p.equippedMainHandInventoryId ||
        _old.equippedOffHand !== p.equippedOffHand ||
        _old.equippedOffHandInventoryId !== p.equippedOffHandInventoryId;
      if (equipmentChanged) this.entities.applyEquipment(entry);
      this.applyPresence(entry);
    });
    conn.db.player.onDelete((_ctx, p) => this.removePlayer(p.identity.toHexString()));

    // AFK eligibility is derived from the skills table (GDD "Presence"), and
    // a snapshot can land skills rows after their player row — so re-evaluate
    // hidden troggs whenever XP arrives, and let the coach announce the
    // unlock the moment the local trogg crosses the gate.
    const skillsChanged = (playerId: Player["identity"]): void => {
      const id = playerId.toHexString();
      if (id === this.myId && this.totalXpOf(playerId) >= AFK_UNLOCK_XP) coachHit("afk-unlocked");
      const p = conn.db.player.identity.find(playerId);
      if (!p || p.zoneId !== this.slug) return;
      if (!this.tracked.has(id) && !this.hiddenNow(p)) this.addPlayer(p);
    };
    conn.db.skills.onInsert((_ctx, row) => skillsChanged(row.playerId));
    conn.db.skills.onUpdate((_ctx, _old, row) => skillsChanged(row.playerId));
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
    if (this.hiddenNow(p)) return;

    const face = playerFacing(p);
    const facing = facingFromDir(face.dirX, face.dirY, "down");
    const style = troggStyleFor(p.style, id);
    const color = troggColorFor(p.color, id);
    const presence = this.presenceNow(p);
    const built = this.entities.makeMarker(p.name, color, style, id === this.myId, facing, p.health, p.dead, presence, p.respawnAt);
    const entry: Tracked = {
      presence,
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
    this.applyPresence(entry);
  }

  private presenceNow(p: Player): Presence {
    return presenceOf(p.online);
  }

  /** Total XP across a trogg's skills rows — what its overall level and the
   *  AFK eligibility gate derive from (GDD "Skills and XP"; "Presence"). */
  private totalXpOf(playerId: Player["identity"]): number {
    const hex = playerId.toHexString();
    let sum = 0;
    for (const r of this.conn.db.skills.iter()) if (r.playerId.toHexString() === hex) sum += r.xp;
    return sum;
  }

  /** Whether a trogg is out of the world right now: offline and below the
   *  AFK eligibility gate (GDD "Presence") — a plain offline, not an AFK
   *  body. Never true for the local trogg or anyone online. */
  private hiddenNow(p: Player): boolean {
    if (p.online || p.identity.toHexString() === this.myId) return false;
    if (Date.now() - timestampMs(p.kindlingChargeAt) >= AFK_HIDE_AFTER_MS) return true; // a week away
    return this.totalXpOf(p.identity) < AFK_UNLOCK_XP;
  }

  /** Dim a tracked trogg's body to its current presence (GDD "The fire and
   *  the dark" → Presence) and, on a transition, rebuild its marker so the
   *  name tag re-styles. Skipped while dead — `setDowned`'s translucency and
   *  the dead name colour own that state instead. */
  private applyPresence(entry: Tracked): void {
    if (entry.player.dead) return;
    const presence = this.presenceNow(entry.player);
    if (presence !== entry.presence) this.rebuildMarker(entry.player.identity.toHexString(), entry);
    setPresenceDim(entry.model, presence);
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
    conn.db.boulder.onInsert((_ctx, b) => {
      // Seeded boulders (boot) just appear. Once live, a boulder that lands where
      // someone stopped carrying one was thrown — arc it in from their hands. The
      // decision waits a microtask so the release (the thrower's F-press or, for
      // a bystander, the carry-cleared update from the same transaction) is
      // recorded first, so the arc shows for everyone, not only the thrower.
      if (!this.sub.live) return this.upsertBoulder(b);
      queueMicrotask(() => {
        const from = this.takeThrowOrigin("boulder");
        if (from) this.flyGhost(buildBoulder(), from, b.x + 0.5, b.y + 0.5, thrownFlightMs(from.distanceTo(new THREE.Vector3(b.x + 0.5, 0, b.y + 0.5))), () => this.upsertBoulder(b));
        else this.upsertBoulder(b);
      });
    });
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

  /** Refresh the claimed/penumbra region sets and rebuild terrain against the
   *  new boundary (GDD "Generation: only as far as the light reaches") —
   *  unrevealed ground is a hard wall until a group clears it and claims it. */
  private refreshRevealedRegions(): void {
    this.revealedRegions.clear();
    this.regionNames.clear();
    for (const row of this.conn.db.revealedRegion.iter()) {
      if (row.interior) this.revealedRegions.add(row.slug);
      this.regionNames.set(row.slug, row.name);
    }
    this.penumbraRegions = penumbraOf(this.revealedRegions);
    this.terrain.invalidate();
  }

  private wireRevealedRegions(): void {
    const conn = this.conn;
    conn.db.revealedRegion.onInsert(() => this.refreshRevealedRegions());
    // a claim flips an existing row's interior flag, so updates move the frontier too
    conn.db.revealedRegion.onUpdate(() => this.refreshRevealedRegions());
    conn.db.revealedRegion.onDelete(() => this.refreshRevealedRegions());
  }

  /** A hearth or brazier: the stone ring + fire (`buildBrazier`) plus a flat
   *  lit-ground disc scaled to its radius — the visible edge of claimed
   *  territory (GDD "The fire and the dark" → Territory and permanence). */
  private upsertBrazier(row: Brazier): void {
    const key = row.id.toString();
    let view = this.braziers.get(key);
    if (!view) {
      const group = buildBrazier();
      // A shadow-casting point light re-renders a six-face cube map every
      // frame, so shadows are budgeted: cullDistant enables castShadow on the
      // nearest lit fire only — standing at a fire throws your second shadow,
      // and a zone full of braziers costs one cube map, not dozens.
      const light = new THREE.PointLight(0xff8c2e, 9, Math.max(14, row.radius * 2.4), 1.6);
      light.position.set(0.5, 0.7, 0.5);
      light.shadow.mapSize.set(512, 512);
      light.shadow.camera.near = 0.3;
      light.shadow.bias = -0.005;
      group.add(light);
      // No billboard halo here: a camera-facing additive sprite spills its
      // glow onto whatever ground sits behind the fire from the viewer's
      // angle — a lit smear that swings around the fire as the camera
      // orbits. The flame cels, the flicker, and the warm fill are the fire.
      const ground = new THREE.Mesh(
        new THREE.RingGeometry(0.6, row.radius, 32),
        new THREE.MeshBasicMaterial({ color: 0xff8c2e, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(0.5, 0.02, 0.5);
      // The terrain floor is itself in the transparent queue (terrain.ts), and
      // three.js sorts that queue by camera distance: floor meshes nearer than
      // the fire draw AFTER this depthWrite-less disc and paint straight over
      // it — cutting the "glow" to the half-disc beyond the fire, a semicircle
      // that swings as the camera orbits. renderOrder 1 keeps the disc after
      // every floor mesh regardless of the camera angle.
      ground.renderOrder = 1;
      group.add(ground);
      view = { row, group, fx: { cels: group.userData.flameCels as THREE.Group[], light }, ground };
      this.braziers.set(key, view);
      this.scene.add(group);
      this.entities.place(group, row.x, row.y);
    }
    view.row = row;
    view.fx.light!.visible = row.lit;
    for (const cel of view.fx.cels ?? []) cel.visible = false;
    if (view.fx.cels?.[0]) view.fx.cels[0].visible = row.lit;
    view.ground.visible = row.lit;
  }

  private removeBrazier(row: Brazier): void {
    const view = this.braziers.get(row.id.toString());
    if (view) disposeObject(view.group);
    this.braziers.delete(row.id.toString());
  }

  private wireBraziers(): void {
    const conn = this.conn;
    conn.db.brazier.onInsert((_ctx, row) => {
      this.upsertBrazier(row);
      this.syncLitRegions();
    });
    conn.db.brazier.onUpdate((_ctx, _old, row) => {
      this.upsertBrazier(row);
      this.syncLitRegions();
    });
    conn.db.brazier.onDelete((_ctx, row) => {
      this.removeBrazier(row);
      this.syncLitRegions();
    });
  }

  private upsertDarkCreature(row: DarkCreature): void {
    bumpPerf("rows_creature");
    const key = row.id.toString();
    let view = this.darkCreatures.get(key);
    const def = DARK_CREATURES[row.species as keyof typeof DARK_CREATURES] ?? Object.values(DARK_CREATURES)[0]!;
    if (!view) {
      const group = new THREE.Group();
      const model = buildGrask();
      model.root.position.set(0.5, 0, 0.5);
      group.add(model.root);
      model.actions.idle.legs.play();
      model.actions.idle.arms.play();
      const health = makeHealthBar(Math.max(0, Math.min(1, row.health / def.maxHealth)), row.health <= 0);
      health.sprite.position.set(0.5, model.height + 0.28, 0.5);
      group.add(health.sprite);
      view = { row, group, model, health, gait: "idle", baseMs: timestampBaseMs(row.movedAt), downed: false };
      this.darkCreatures.set(key, view);
      this.scene.add(group);
      this.entities.place(group, row.x, row.y);
    }
    if (row.health < view.row.health) {
      view.flashUntil = performance.now() + FLINCH_MS;
      view.health.dispose();
      const health = makeHealthBar(Math.max(0, Math.min(1, row.health / def.maxHealth)), row.health <= 0);
      health.sprite.position.set(0.5, view.model.height + 0.28, 0.5);
      view.group.add(health.sprite);
      view.health = health;
    }
    if (row.movedAt.microsSinceUnixEpoch !== view.row.movedAt.microsSinceUnixEpoch) view.baseMs = timestampBaseMs(row.movedAt);
    if (row.attackAt.microsSinceUnixEpoch !== view.row.attackAt.microsSinceUnixEpoch) {
      view.model.actions[view.gait].arms.fadeOut(0.05);
      view.attacking?.stop();
      view.attacking = view.model.actions.attacks.swing;
      view.attacking.reset().setDuration(ATTACK_PERIOD).fadeIn(0.05).play();
      view.attackBaseMs = performance.now();
    }
    if (row.health <= 0 && !view.downed) {
      view.downed = true;
      setDowned(view.model, true);
      poseDead(view.model, 0.5, 0.18);
    }
    view.row = row;
  }

  private removeDarkCreature(row: DarkCreature): void {
    const key = row.id.toString();
    const view = this.darkCreatures.get(key);
    if (view) disposeObject(view.group);
    this.darkCreatures.delete(key);
  }

  private wireDarkCreatures(): void {
    const conn = this.conn;
    conn.db.darkCreature.onInsert((_ctx, row) => this.upsertDarkCreature(row));
    conn.db.darkCreature.onUpdate((_ctx, _old, row) => this.upsertDarkCreature(row));
    conn.db.darkCreature.onDelete((_ctx, row) => this.removeDarkCreature(row));
  }

  private wireGhostHaunts(): void {
    this.conn.db.ghostHaunt.onInsert((_ctx, haunt) => {
      // Render only fresh inserts, so a joiner doesn't replay the backlog as a swarm.
      if (Date.now() - timestampMs(haunt.createdAt) > GHOST_HAUNT_FRESH_MS) return;
      this.entities.hauntGhost({ x: haunt.x, y: haunt.y, id: haunt.id });
    });
  }
}
