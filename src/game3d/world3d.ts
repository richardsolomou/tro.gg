import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createOrbit } from "./controls3d.js";
import {
  CHAT_BUBBLE_MS,
  DIR_SCALE,
  facingFromDir,
  footprintTiles,
  getZone,
  GHOST_HAUNT_FRESH_MS,
  hogSize,
  hogStyleFor,
  PLAYER_RESPAWN_MS,
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
} from "@trogg/shared";
import type { DbConnection } from "../net/module_bindings";
import type { Boulder, GroundItem, Hog, Player } from "../net/module_bindings/types";
import { attachKeyboard, type MoveIntent } from "../input.js";
import { setupChat } from "../ui/chat.js";
import { mountCommands } from "../ui/commands.js";
import { createSelfController, type SelfController } from "../movement.js";
import { captureEvent, isFeatureEnabled, logError, logInfo } from "../analytics.js";
import { audio } from "../audio.js";
import { interact, useEquipped } from "../net/procedures.js";
import { isOlderPlayerMotion, playerMotionChanged, withPlayerMotion } from "../motion_sync.js";
import { createEntities, disposeObject, type Entities, type HogView, type Tracked } from "./entities3d.js";
import { buildTerrain, type Terrain3D } from "./terrain3d.js";
import { CAVE_3D, UI_3D } from "./palette.js";

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
}

/**
 * The 3D game world (GDD "Camera and rendering"): renders the zone in Three.js and
 * runs the per-frame extrapolation loop. Movement stays intent-based — the `player`
 * table syncs origin/direction/start-time and every client extrapolates locally each
 * frame (invariant 2); all authority stays server-side (invariant 3). This is the
 * WorldScene port: same subscriptions, same prediction wiring, a 3D renderer.
 */
export class World3D {
  private readonly conn: DbConnection;
  private readonly slug = STARTING_ZONE_SLUG;
  private readonly zone = getZone(STARTING_ZONE_SLUG)!;
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
  private readonly boulders = new Map<string, { row: Boulder; group: THREE.Group }>();
  private readonly groundItems = new Map<string, { row: GroundItem; group: THREE.Group }>();
  private readonly hogs = new Map<string, HogView>();

  private readonly boulderTiles = new Set<string>();
  private readonly hogTiles = new Set<string>();
  private hogBounds!: ZoneBounds;
  private troggBounds!: ZoneBounds;

  private destinationTile?: Coord;
  private readonly sub = { live: false };
  private lastMs = performance.now();
  /** The raw screen-space WASD intent and its last camera-mapped delivery, so the
   *  tick can re-steer a held walk when the camera turns. */
  private rawIntent: MoveIntent = { dirX: 0, dirY: 0, running: false };
  private lastMapped: MoveIntent = { dirX: 0, dirY: 0, running: false };

  private useHogs = false;
  private useGhost = false;
  private canRun = false;
  private useInteract = false;

  constructor(parent: HTMLElement, data: WorldData) {
    this.conn = data.conn;
    this.parent = parent;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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

    this.hogBounds = zoneBounds(this.zone, (x, y) => this.boulderTiles.has(tileKey(x, y)));
    this.troggBounds = zoneBounds(this.zone, (x, y) => this.boulderTiles.has(tileKey(x, y)) || this.hogTiles.has(tileKey(x, y)));

    // Torch-lit cave: dim warm ambient, one shadowing key light, dark fog closing in
    // past the zone. Glowmoss tiles add their own teal point lights (terrain3d).
    this.scene.background = new THREE.Color(CAVE_3D.voidBase);
    this.scene.fog = new THREE.Fog(CAVE_3D.voidBase, 26, 60);
    this.scene.add(new THREE.HemisphereLight(0xffe0b0, 0x201409, 0.75));
    const key = new THREE.DirectionalLight(0xffd9a0, 1.6);
    key.position.set(this.zone.width / 2 + 6, 14, this.zone.height / 2 + 8);
    key.target.position.set(this.zone.width / 2, 0, this.zone.height / 2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -this.zone.width;
    key.shadow.camera.right = this.zone.width;
    key.shadow.camera.top = this.zone.height;
    key.shadow.camera.bottom = -this.zone.height;
    this.scene.add(key, key.target);

    this.terrain = buildTerrain(this.zone);
    this.scene.add(this.terrain.group);
    this.entities = createEntities(this.scene);

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
      hogTiles: this.hogTiles,
      boulderTiles: this.boulderTiles,
      pushEnabled: isFeatureEnabled("boulder-pushing"),
      getSelf: () => (this.myId ? this.tracked.get(this.myId) : undefined),
      showDestination: (tile) => {
        this.destinationTile = tile;
        this.drawDestination();
      },
      toBaseMs: timestampBaseMs,
      facingFromDir,
      audio,
    });

    this.wirePlayers();
    this.wireGroundItems();
    this.wireBoulders();
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
        void useEquipped(conn, this.self.facing.dirX, this.self.facing.dirY).catch((err) => {
          logError("Use equipped action failed", { surface: "world", action: "use_equipped", zone: this.slug, error: err });
        });
      },
      this.canRun,
    );

    // Click-to-move: cast the pointer through the camera onto the floor plane and
    // walk to that tile. HUD panels consume their own clicks (pointer-events), so
    // only open-space clicks reach the canvas. Dragging orbits the camera instead,
    // so a click only moves when the pointer barely travelled between down and up.
    const ray = new THREE.Raycaster();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let downAt: { x: number; y: number } | undefined;
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      downAt = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      const wasClick = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6;
      downAt = undefined;
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
    const dt = Math.min(0.1, (now - this.lastMs) / 1000);
    this.lastMs = now;

    // Hogs first, so trogg collision this frame sees where the Hogs actually are.
    this.hogTiles.clear();
    for (const view of this.hogs.values()) {
      const size = hogSize(view.style);
      const motion = projectMotionState({ ...view.row, size }, now - view.baseMs, this.hogBounds);
      this.entities.smoothPlace(view, motion.x, motion.y, dt);
      this.entities.animateHog(view, now, dt, motion);
      const tile = snapToTile({ x: motion.x, y: motion.y });
      for (const t of footprintTiles(tile.x, tile.y, size)) this.hogTiles.add(tileKey(t.x, t.y));
    }

    for (const entry of this.tracked.values()) {
      const motion = projectMotionState(entry.player, now - entry.baseMs, this.troggBounds);
      this.entities.smoothPlace(entry, motion.x, motion.y, dt);
      this.entities.animate(entry, now, dt, motion);

      if (entry.player.identity.toHexString() !== this.myId) continue;
      // The camera rides the local trogg: the orbit pivot glides to its position, so
      // drag-to-rotate and wheel-zoom stay live while walking (dead or alive — you
      // keep your camera while waiting to respawn).
      if (this.orbit) {
        const pivot = new THREE.Vector3(motion.x + 0.5, 0.6, motion.y + 0.5);
        const shift = pivot.sub(this.orbit.target).multiplyScalar(Math.min(1, dt * 8));
        this.orbit.target.add(shift);
        this.camera.position.add(shift); // carry the camera with the pivot so following doesn't re-aim the view
      }
      if (entry.player.dead) continue;
      this.self.update(entry, motion, now);
      // Exposed for the e2e harness: the local trogg's projected tile position.
      (window as unknown as { __troggPos?: { x: number; y: number } }).__troggPos = { x: motion.x, y: motion.y };
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
    this.orbit.maxDistance = hi * 1.7;
    this.orbit.minPolarAngle = 0.25; // not dead top-down…
    this.orbit.maxPolarAngle = 1.35; // …and never under the floor
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
    entry.attacking = false;
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
      if (!p.dead && p.health < _old.health) entry.flinchBaseMs = performance.now();

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
      attacking: false,
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
    for (const view of this.boulders.values()) this.boulderTiles.add(tileKey(view.row.x, view.row.y));
  }

  private upsertBoulder(b: Boulder): void {
    const key = b.id.toString();
    let view = this.boulders.get(key);
    if (!view) {
      view = { row: b, group: this.entities.makeBoulder() };
      this.boulders.set(key, view);
      this.scene.add(view.group);
    } else {
      view.row = b;
    }
    this.entities.place(view.group, b.x, b.y);
    this.syncBoulderTiles();
  }

  private removeBoulder(b: Boulder): void {
    const view = this.boulders.get(b.id.toString());
    if (view) disposeObject(view.group);
    this.boulders.delete(b.id.toString());
    this.syncBoulderTiles();
  }

  private wireBoulders(): void {
    const conn = this.conn;
    conn.db.boulder.onInsert((_ctx, b) => this.upsertBoulder(b));
    conn.db.boulder.onUpdate((_ctx, _old, b) => {
      if (this.sub.live && (_old.x !== b.x || _old.y !== b.y)) audio.playBoulderSettle();
      this.upsertBoulder(b);
    });
    conn.db.boulder.onDelete((_ctx, b) => this.removeBoulder(b));
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
        if (view) view.flinchBaseMs = performance.now();
      }
      if (!this.sub.live) return;
      const changedHeading = _old.dirX !== h.dirX || _old.dirY !== h.dirY;
      if (changedHeading && Math.random() < 0.35) audio.playHog();
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
