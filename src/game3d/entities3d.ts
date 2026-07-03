import * as THREE from "three";
import { forward, HOG_MAX_HEALTH, hogSize, PLAYER_MAX_HEALTH, RUN_SPEED_TILES_PER_SEC, timestampMs, type EquipSlot, type Facing, type ProjectedMotion, type Stamp } from "@trogg/shared";
import type { Player } from "../net/module_bindings/types";
import { audio } from "../audio.js";
import { buildGhost, buildHog, buildHogBall, buildTrogg } from "./creatures3d.js";
import { buildBoulder, buildGroundItem, buildHeldItem } from "./items3d.js";
import { makeBubble, makeHealthBar, makeLabel, makeStatusText, type Overlay } from "./overlays3d.js";
import { ATTACK_PERIOD, type CreatureModel } from "./rig3d.js";
import { UI_3D } from "./palette.js";

/**
 * 3D entity builders and per-frame drivers — the renderer half of the world,
 * mirroring the 2D `createEntities` contract: it builds display objects from game
 * state (no netcode or prediction) and the world scene places and animates them.
 * All positions are in tile units on the XZ plane; `place` pins an object's tile
 * anchor, and each creature group centres its own footprint.
 */

/** How long a visible equipment use impulse lasts — a quick strike plus recovery. */
const EQUIPMENT_ACTION_MS = 300;
/** How fast a render-position correction closes (per second): ~120 ms to glide out. */
const CORRECTION_DECAY = 9;
/** Corrections beyond this are genuine teleports (respawn, zone snap) — don't glide. */
const CORRECTION_MAX = 2.5;
/** How long a hit-flinch (recoil + flash) plays. */
export const FLINCH_MS = 240;
/** The flinch recoil distance, in tiles. */
const FLINCH_SHOVE = 0.1;
const GHOST_FADE_IN_MS = 900;
const GHOST_HOLD_MS = 2400;
const GHOST_FADE_OUT_MS = 1200;
const GHOST_PEAK_ALPHA = 0.82;
const GHOST_DRIFT_TILES = 0.44;

type Gait = "idle" | "walk" | "run";

/** A player's live display state plus the fields the prediction controller drives
 *  (`player`/`baseMs`/`facing` — see `MotionEntry` in movement.ts). */
export interface Tracked {
  marker: THREE.Group;
  model: CreatureModel;
  player: Player;
  baseMs: number;
  facing: Facing;
  style: string;
  baseColor: number;
  gait: Gait;
  attacking: boolean;
  flashOn: boolean;
  /** Render-position correction state (`smoothPlace`). */
  shownX?: number;
  shownY?: number;
  corrX: number;
  corrY: number;
  flinchBaseMs?: number;
  equipmentActionBaseMs?: number;
  equip: Partial<Record<EquipSlot, { kind: string }>>;
  carried?: THREE.Group;
  carriedKind: string;
  carriedStyle: string;
  bubble?: Overlay;
  bubbleTimer?: ReturnType<typeof setTimeout>;
  respawn?: { overlay: Overlay; text: string; at: Stamp };
  overlays: Overlay[];
}

/** A roaming Hog's display state. */
export interface HogView {
  marker: THREE.Group;
  model: CreatureModel;
  row: import("../net/module_bindings/types").Hog;
  baseMs: number;
  facing: Facing;
  style: string;
  gait: Gait;
  flashOn: boolean;
  /** Render-position correction state (`smoothPlace`). */
  shownX?: number;
  shownY?: number;
  corrX: number;
  corrY: number;
  flinchBaseMs?: number;
  overlays: Overlay[];
}

/** Recursively free an object's GPU resources and detach it. */
export function disposeObject(obj: THREE.Object3D): void {
  obj.removeFromParent();
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
  });
}

function yawFor(dirX: number, dirY: number): number {
  return Math.atan2(dirX, dirY);
}

function facingYaw(facing: Facing): number {
  const f = forward(facing);
  return yawFor(f.x, f.y);
}

/** Steer `obj` toward a heading, shortest way round, with a snappy exponential ease. */
function steer(obj: THREE.Object3D, targetYaw: number, dt: number): void {
  const delta = THREE.MathUtils.euclideanModulo(targetYaw - obj.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
  obj.rotation.y += delta * Math.min(1, dt * 14);
}

function setGait(model: CreatureModel, state: { gait: Gait }, next: Gait): void {
  if (next === state.gait) return;
  model.actions[state.gait].fadeOut(0.12);
  model.actions[next].reset().fadeIn(0.12).play();
  state.gait = next;
}

/** Fade a model's whole body to the downed translucency (or back). */
function setDowned(model: CreatureModel, downed: boolean): void {
  for (const m of model.materials) {
    m.transparent = downed;
    m.opacity = downed ? 0.45 : 1;
  }
}

/** The hit flinch: recoil the body opposite its facing and flash it white. Shared
 *  with the art preview, so the flinch there is exactly the in-game one. */
export function applyFlinch(view: { model: CreatureModel; facing: Facing; flinchBaseMs?: number; flashOn: boolean }, now: number, centre: number): void {
  const root = view.model.root;
  if (view.flinchBaseMs === undefined) return;
  const t = (now - view.flinchBaseMs) / FLINCH_MS;
  if (t >= 1) {
    view.flinchBaseMs = undefined;
    root.position.set(centre, 0, centre);
    if (view.flashOn) {
      view.model.flash(false);
      view.flashOn = false;
    }
    return;
  }
  const f = forward(view.facing);
  const k = FLINCH_SHOVE * Math.sin(Math.max(0, t) * Math.PI);
  root.position.set(centre - f.x * k, 0, centre - f.y * k);
  const flash = t < 0.35;
  if (flash !== view.flashOn) {
    view.model.flash(flash);
    view.flashOn = flash;
  }
}

export function createEntities(scene: THREE.Scene) {
  /** Live ghost apparitions, advanced by `updateGhosts` each frame. */
  const ghosts: { root: THREE.Group; materials: THREE.Material[]; bornMs: number; from: THREE.Vector3; drift: THREE.Vector3 }[] = [];

  const place = (obj: THREE.Object3D, x: number, y: number) => {
    obj.position.set(x, 0, y);
  };

  /** Place a creature with correction smoothing: projected positions can jump when
   *  collision state changes under a live intent (a Hog claims the tile ahead and the
   *  clamp rewinds the projection; an authority snap lands) — instead of popping, the
   *  rendered marker absorbs the jump into an offset that glides out over ~120 ms.
   *  Prediction and game logic keep using the raw projection; only the render eases. */
  const smoothPlace = (view: { marker: THREE.Group; shownX?: number; shownY?: number; corrX: number; corrY: number; running?: boolean }, x: number, y: number, dt: number) => {
    if (view.shownX === undefined || view.shownY === undefined) {
      view.corrX = 0;
      view.corrY = 0;
    } else {
      const jump = Math.hypot(view.shownX - x, view.shownY - y);
      // Anything the entity couldn't have walked this frame is a correction to absorb.
      const maxStep = RUN_SPEED_TILES_PER_SEC * dt + 0.06;
      if (jump > CORRECTION_MAX) {
        view.corrX = 0; // a real teleport — snap
        view.corrY = 0;
      } else if (jump > maxStep) {
        view.corrX = view.shownX - x;
        view.corrY = view.shownY - y;
      }
      const decay = Math.exp(-CORRECTION_DECAY * dt);
      view.corrX *= decay;
      view.corrY *= decay;
    }
    view.shownX = x + view.corrX;
    view.shownY = y + view.corrY;
    place(view.marker, view.shownX, view.shownY);
  };

  /** Top of a trogg's head in world units — where labels and bubbles hang. */
  const headTop = () => 1.75;

  const makeMarker = (name: string, color: number, style: string, self: boolean, facing: Facing, health: number, dead: boolean, respawnAt?: Stamp) => {
    const marker = new THREE.Group();
    const model = buildTrogg(style, color);
    model.root.position.set(0.5, 0, 0.5);
    model.root.rotation.y = facingYaw(facing);
    marker.add(model.root);
    model.actions.idle.play();
    if (dead) setDowned(model, true);

    const overlays: Overlay[] = [];
    if (self) {
      // a bright ground ring under the feet so you can pick yourself out
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.36, 24), new THREE.MeshBasicMaterial({ color: UI_3D.parchment, transparent: true, opacity: 0.85 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0.5, 0.015, 0.5);
      marker.add(ring);
    }
    const label = makeLabel(name, dead ? UI_3D.deadName : UI_3D.parchment);
    label.sprite.position.set(0.5, model.height + 0.5, 0.5);
    marker.add(label.sprite);
    overlays.push(label);

    const ratio = PLAYER_MAX_HEALTH <= 0 ? 0 : Math.max(0, Math.min(PLAYER_MAX_HEALTH, health)) / PLAYER_MAX_HEALTH;
    const bar = makeHealthBar(ratio, dead);
    bar.sprite.position.set(0.5, model.height + 0.32, 0.5);
    marker.add(bar.sprite);
    overlays.push(bar);

    let respawn: Tracked["respawn"];
    if (dead && respawnAt) {
      const text = respawnCountdown(respawnAt);
      const overlay = makeStatusText(text);
      overlay.sprite.position.set(0.5, model.height + 0.14, 0.5);
      marker.add(overlay.sprite);
      overlays.push(overlay);
      respawn = { overlay, text, at: respawnAt };
    }
    return { marker, model, overlays, respawn };
  };

  const respawnCountdown = (respawnAt: Stamp): string => `Respawn ${Math.ceil(Math.max(0, timestampMs(respawnAt) - Date.now()) / 1000)}`;

  /** Progress [0,1) through the current equipment-use action, or undefined when idle. */
  const attackPhase = (entry: Tracked, now: number): number | undefined => {
    if (entry.equipmentActionBaseMs === undefined || !entry.player.equipmentAction) return undefined;
    const age = now - entry.equipmentActionBaseMs;
    return age >= 0 && age < EQUIPMENT_ACTION_MS ? age / EQUIPMENT_ACTION_MS : undefined;
  };

  /** Point a creature at its motion and pick the gait action; shared by troggs and
   *  Hogs. The attack action overrides the gait for its duration, then hands back. */
  const driveCreature = (
    model: CreatureModel,
    state: { facing: Facing; gait: Gait },
    dirX: number,
    dirY: number,
    running: boolean,
    dt: number,
    moving: boolean,
    attack: boolean,
  ) => {
    if (dirX !== 0 || dirY !== 0) {
      state.facing = Math.abs(dirX) >= Math.abs(dirY) ? (dirX < 0 ? "left" : "right") : dirY < 0 ? "up" : "down";
      steer(model.root, yawFor(dirX, dirY), dt);
    } else {
      steer(model.root, facingYaw(state.facing), dt);
    }
    if (!attack) setGait(model, state, moving ? (running ? "run" : "walk") : "idle");
  };

  /** Start (or continue) the one-shot attack action alongside the gait. */
  const driveAttack = (entry: Tracked, now: number) => {
    const phase = attackPhase(entry, now);
    if (phase !== undefined && !entry.attacking) {
      entry.attacking = true;
      entry.model.actions[entry.gait].fadeOut(0.05);
      entry.model.actions.attack.reset().setDuration(ATTACK_PERIOD).fadeIn(0.05).play();
    } else if (phase === undefined && entry.attacking) {
      entry.attacking = false;
      entry.model.actions.attack.fadeOut(0.1);
      entry.model.actions[entry.gait].reset().fadeIn(0.1).play();
    }
  };

  /** Per-frame trogg driver: gait + attack + flinch + respawn countdown + mixer. */
  const animate = (entry: Tracked, now: number, dt: number, motion: ProjectedMotion) => {
    const moving = motion.dirX !== 0 || motion.dirY !== 0;
    const faceX = moving ? motion.dirX : entry.player.faceX;
    const faceY = moving ? motion.dirY : entry.player.faceY;
    driveCreature(entry.model, entry, faceX, faceY, entry.player.running, dt, moving, entry.attacking);
    driveAttack(entry, now);
    applyFlinch(entry, now, 0.5);
    if (entry.respawn && entry.player.respawnAt) {
      const text = respawnCountdown(entry.player.respawnAt);
      if (text !== entry.respawn.text) {
        const next = makeStatusText(text);
        next.sprite.position.copy(entry.respawn.overlay.sprite.position);
        entry.marker.add(next.sprite);
        entry.marker.remove(entry.respawn.overlay.sprite);
        entry.respawn.overlay.dispose();
        entry.respawn = { overlay: next, text, at: entry.player.respawnAt };
      }
    }
    entry.model.mixer.update(dt);
  };

  const makeHog = (style: string, facing: Facing, health: number) => {
    const size = hogSize(style);
    const marker = new THREE.Group();
    const model = buildHog(style);
    const c = size / 2;
    model.root.position.set(c, 0, c);
    model.root.scale.setScalar(size);
    model.root.rotation.y = facingYaw(facing);
    marker.add(model.root);
    model.actions.idle.play();
    const overlays: Overlay[] = [];
    const hp = Math.max(0, Math.min(HOG_MAX_HEALTH, health));
    if (hp < HOG_MAX_HEALTH) {
      const bar = makeHealthBar(HOG_MAX_HEALTH <= 0 ? 0 : hp / HOG_MAX_HEALTH, false);
      bar.sprite.position.set(c, model.height * size + 0.24, c);
      marker.add(bar.sprite);
      overlays.push(bar);
    }
    return { marker, model, overlays };
  };

  /** Per-frame Hog driver (Hogs always walk; no attack). */
  const animateHog = (view: HogView, now: number, dt: number, motion: ProjectedMotion) => {
    driveCreature(view.model, view, motion.dirX, motion.dirY, false, dt, motion.dirX !== 0 || motion.dirY !== 0, false);
    applyFlinch(view, now, hogSize(view.style) / 2);
    view.model.mixer.update(dt);
  };

  const makeBoulder = () => {
    const marker = new THREE.Group();
    const rock = buildBoulder();
    rock.position.set(0.5, 0, 0.5);
    marker.add(rock);
    return marker;
  };

  const makeGroundItem = (item: string) => {
    const marker = new THREE.Group();
    const glyph = buildGroundItem(item);
    if (glyph) {
      glyph.position.set(0.5, 0, 0.5);
      marker.add(glyph);
    }
    return marker;
  };

  /** Sync the carried overlay (boulder / curled hog) to the player row. */
  const applyCarry = (entry: Tracked) => {
    const kind = entry.player.carrying;
    const style = kind === "hog" ? entry.player.carryingStyle || "classic" : "";
    if (kind === entry.carriedKind && style === entry.carriedStyle) return;
    if (entry.carried) disposeObject(entry.carried);
    entry.carried = undefined;
    entry.carriedKind = "";
    entry.carriedStyle = "";
    let overlay: THREE.Group | undefined;
    if (kind === "boulder") {
      overlay = buildBoulder();
      overlay.scale.setScalar(0.7);
    } else if (kind === "hog") {
      // a picked-up hog curls into its defensive ball; the chicken has no ball and
      // rides upright instead (GDD "Hog ball form")
      if (style === "chicken") {
        overlay = buildHog("chicken").root;
        overlay.scale.setScalar(0.8);
      } else {
        overlay = buildHogBall(style);
      }
    }
    if (!overlay) return;
    overlay.position.set(0, entry.model.height + 0.18, 0);
    // ride the body (not the marker) so the carry recoils with the flinch
    entry.model.root.add(overlay);
    entry.carried = overlay;
    entry.carriedKind = kind;
    entry.carriedStyle = style;
  };

  /** Sync held items to the equipped rows: parent each item model to the rig's hand
   *  node, so it rides the animated (swinging, striking) arm with no placement math. */
  const applyEquipment = (entry: Tracked) => {
    const slots: { slot: EquipSlot; item: string; hand: THREE.Group }[] = [
      { slot: "mainHand", item: entry.player.equippedMainHand, hand: entry.model.handR },
      { slot: "offHand", item: entry.player.equippedOffHand, hand: entry.model.handL },
    ];
    for (const { slot, item, hand } of slots) {
      const cur = entry.equip[slot];
      if (item === (cur?.kind ?? "")) continue;
      for (const child of [...hand.children]) disposeObject(child);
      delete entry.equip[slot];
      if (!item) continue;
      const model = buildHeldItem(item);
      if (!model) continue;
      hand.add(model);
      entry.equip[slot] = { kind: item };
    }
  };

  /** Pop a speech bubble over a trogg's head, replacing any current one. */
  const showBubble = (entry: Tracked, text: string, ttlMs: number) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    if (entry.bubble) {
      entry.marker.remove(entry.bubble.sprite);
      entry.bubble.dispose();
    }
    const bubble = makeBubble(text);
    bubble.sprite.position.set(0.5, headTop() + 0.85, 0.5);
    entry.marker.add(bubble.sprite);
    entry.bubble = bubble;
    entry.bubbleTimer = setTimeout(() => {
      if (entry.bubble === bubble) {
        entry.marker.remove(bubble.sprite);
        bubble.dispose();
        entry.bubble = undefined;
        entry.bubbleTimer = undefined;
      }
    }, ttlMs);
  };

  /** Tear down a tracked trogg (or hog view): timers, overlays, GPU resources. */
  const destroy = (entry: { marker: THREE.Group; overlays: Overlay[]; bubbleTimer?: ReturnType<typeof setTimeout>; bubble?: Overlay; respawn?: Tracked["respawn"] }) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.bubble?.dispose();
    entry.respawn?.overlay.dispose();
    for (const o of entry.overlays) o.dispose();
    disposeObject(entry.marker);
  };

  /** Cosmetic ghost apparition: materialise, drift, linger, dissolve (GDD easter egg). */
  const hauntGhost = (tile: { x: number; y: number; id?: bigint }) => {
    audio.playGhost();
    const root = buildGhost();
    const materials: THREE.Material[] = [];
    root.traverse((child) => {
      const m = (child as THREE.Mesh).material as THREE.Material | undefined;
      if (m) {
        m.transparent = true;
        m.opacity = 0;
        materials.push(m);
      }
    });
    const idPart = tile.id === undefined ? 0 : Number(tile.id % 2_147_483_647n);
    const seed = (idPart ^ Math.imul(tile.x + 1, 374_761_393) ^ Math.imul(tile.y + 1, 668_265_263)) >>> 0;
    const angle = ((seed % 360) * Math.PI) / 180;
    const from = new THREE.Vector3(tile.x + 0.5, 0, tile.y + 0.5);
    const drift = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle) * 0.72).multiplyScalar(GHOST_DRIFT_TILES);
    root.position.copy(from);
    scene.add(root);
    ghosts.push({ root, materials, bornMs: performance.now(), from, drift });
  };

  /** Advance ghost timelines; call once per frame. */
  const updateGhosts = (now: number) => {
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i]!;
      const age = now - g.bornMs;
      const lifetime = GHOST_FADE_IN_MS + GHOST_HOLD_MS + GHOST_FADE_OUT_MS;
      if (age >= lifetime) {
        disposeObject(g.root);
        ghosts.splice(i, 1);
        continue;
      }
      const alpha =
        age < GHOST_FADE_IN_MS
          ? (age / GHOST_FADE_IN_MS) * GHOST_PEAK_ALPHA
          : age < GHOST_FADE_IN_MS + GHOST_HOLD_MS
            ? GHOST_PEAK_ALPHA
            : GHOST_PEAK_ALPHA * (1 - (age - GHOST_FADE_IN_MS - GHOST_HOLD_MS) / GHOST_FADE_OUT_MS);
      for (const m of g.materials) m.opacity = alpha * ((m as THREE.MeshStandardMaterial).userData.baseOpacity ?? 1);
      const ease = Math.sin(Math.min(1, age / lifetime) * Math.PI * 0.5);
      g.root.position.copy(g.from).addScaledVector(g.drift, ease);
      g.root.position.y = Math.sin(age / 700) * 0.05;
    }
  };

  return { place, smoothPlace, headTop, makeMarker, animate, makeHog, animateHog, makeBoulder, makeGroundItem, applyCarry, applyEquipment, showBubble, destroy, hauntGhost, updateGhosts };
}

export type Entities = ReturnType<typeof createEntities>;
