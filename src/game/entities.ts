import * as THREE from "three";
import { EQUIPMENT_ACTION_MS, forward, MELEE_ARC_RAD, MELEE_RANGE_TILES, PLAYER_HIT_RADIUS, PLAYER_MAX_HEALTH, RUN_SPEED_TILES_PER_SEC, timestampMs, wieldOf, type EquipSlot, type Facing, type Presence, type ProjectedMotion, type Stamp } from "@trogg/shared";
import type { Player } from "../net/module_bindings/types";
import { audio } from "../audio.js";
import { buildGhost, buildTrogg } from "./creatures.js";
import { buildBoulder, buildGroundItem, buildHeldItem, updateHeldFx, wireHeldFx, type HeldFx } from "./items.js";
import { makeBubble, makeDamageText, makeHealthBar, makeLabel, makeStatusText, type Overlay } from "./overlays.js";
import { ATTACK_PERIOD, type CreatureModel } from "./rig.js";
import { UI_3D } from "./palette.js";

/**
 * Entity builders and per-frame drivers — the renderer half of the world: it
 * builds display objects from game state (no netcode or prediction) and the
 * world scene places and animates them.
 * All positions are in tile units on the XZ plane; `place` pins an object's tile
 * anchor, and each creature group centres its own footprint.
 */

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
  /** The in-flight attack action, so the same one fades out when the impulse ends. */
  attacking?: THREE.AnimationAction;
  /** The impulse the in-flight attack was started for — a fresh stamp mid-swing
   *  (chained attacks) restarts the strike. */
  attackingBaseMs?: number;
  /** The tile last stepped on, for distance-faded footsteps of OTHER troggs. */
  lastStepTile?: string;
  flashOn: boolean;
  /** Render-position correction state (`smoothPlace`). */
  shownX?: number;
  shownY?: number;
  corrX: number;
  corrY: number;
  flinchBaseMs?: number;
  equipmentActionBaseMs?: number;
  equip: Partial<Record<EquipSlot, { kind: string; fx?: HeldFx; arm?: THREE.Object3D }>>;
  /** The equipped torch's firelight, when one is held (world budgets which are lit). */
  torchLight?: THREE.PointLight;
  carried?: THREE.Group;
  carriedKind: string;
  carriedStyle: string;
  bubble?: Overlay;
  bubbleTimer?: ReturnType<typeof setTimeout>;
  respawn?: { overlay: Overlay; text: string; at: Stamp };
  overlays: Overlay[];
}

/** Recursively free an object's GPU resources and detach it. Pooled resources
 *  (`userData.shared`) stay alive — other instances still render from them. */
export function disposeObject(obj: THREE.Object3D): void {
  obj.removeFromParent();
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && !mesh.geometry.userData.shared) mesh.geometry.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      if (!m.userData.shared) m.dispose();
    }
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

/** Crossfade to a gait. While an attack holds the upper body, only the legs layer
 *  follows the gait change — the arms layer rejoins when the attack releases it. */
function setGait(model: CreatureModel, state: { gait: Gait }, next: Gait, armsHeld = false): void {
  if (next === state.gait) return;
  const from = model.actions[state.gait];
  const to = model.actions[next];
  from.legs.fadeOut(0.12);
  to.legs.reset().fadeIn(0.12).play();
  from.arms.fadeOut(armsHeld ? 0.05 : 0.12);
  if (!armsHeld) to.arms.reset().fadeIn(0.12).play();
  state.gait = next;
}

/** Fade a model's whole body to the downed translucency (or back). */
export function setDowned(model: CreatureModel, downed: boolean): void {
  for (const m of model.materials) {
    m.transparent = downed;
    m.opacity = downed ? 0.45 : 1;
  }
}

/** Fade a living trogg's body toward its presence (GDD "The fire and the
 *  dark" → Presence): bright is fully opaque, ember dims a touch — working
 *  the margins on instinct — and dormant dims further — present, waiting,
 *  visibly idle. Dead troggs keep `setDowned`'s translucency instead. */
export function setPresenceDim(model: CreatureModel, presence: Presence): void {
  const opacity = presence === "bright" ? 1 : presence === "ember" ? 0.75 : 0.5;
  for (const m of model.materials) {
    m.transparent = opacity < 1;
    m.opacity = opacity;
  }
}

/** Lay a creature on its side — the dead stance. Tipping about the roll axis
 *  works with the rig's rest pose (legs stay in the body plane instead of
 *  dangling), so every creature reads as keeled over. The pose holds because
 *  dead creatures skip their per-frame drive (no steer, no gait). Shared with
 *  the dev preview's "dead" mode, so the stance is authored once. */
export function poseDead(model: CreatureModel, centre: number, lift: number): void {
  model.root.rotation.z = Math.PI / 2;
  model.root.position.set(centre, lift, centre);
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

/** Motes in the pickup sparkle every ground item carries. */
const PICKUP_MOTES = 4;

/** How long a floating damage number lives, rising and fading. */
const DAMAGE_FLOAT_MS = 900;
const DAMAGE_FLOAT_RISE = 0.9;

export function createEntities(scene: THREE.Scene) {
  /** Live ghost apparitions, advanced by `updateGhosts` each frame. */
  const ghosts: { root: THREE.Group; materials: THREE.Material[]; bornMs: number; from: THREE.Vector3; drift: THREE.Vector3 }[] = [];
  /** Live damage numbers. Scene-anchored (not parented) so one outlives its target. */
  const damageFloats: { overlay: Overlay; bornMs: number; from: THREE.Vector3 }[] = [];

  const place = (obj: THREE.Object3D, x: number, y: number) => {
    obj.position.set(x, 0, y);
  };

  /** Place a creature with correction smoothing: projected positions can jump when
   *  collision state changes under a live intent (an obstacle claims the tile ahead
   *  and the clamp rewinds the projection; an authority snap lands) — instead of
   *  popping, the rendered marker absorbs the jump into an offset that glides out over ~120 ms.
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

  // ── debug hitboxes (Commands panel toggle) ────────────────────────────────────
  // Every creature and boulder carries a hidden ground ring at its combat hit
  // radius; the local trogg also carries its melee reach — range ring plus the
  // swing cone, yawed to the live aim and brightened while a use is in flight.
  const hitboxes: THREE.Object3D[] = [];
  let hitboxesOn = false;
  let selfReach: { group: THREE.Group; wedge: THREE.Mesh } | undefined;

  const hitRing = (radius: number, colour: number): THREE.Object3D => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: colour }));
  };

  const addHitbox = (marker: THREE.Group, obj: THREE.Object3D, c: number) => {
    obj.position.set(c, 0.035, c);
    obj.visible = hitboxesOn;
    marker.add(obj);
    hitboxes.push(obj);
  };

  const addReach = (marker: THREE.Group) => {
    const group = new THREE.Group();
    group.add(hitRing(MELEE_RANGE_TILES, 0xff8c2e));
    const cone = new THREE.CircleGeometry(MELEE_RANGE_TILES, 32, -MELEE_ARC_RAD, MELEE_ARC_RAD * 2);
    cone.rotateX(-Math.PI / 2);
    const wedge = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xff8c2e, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    group.add(wedge);
    addHitbox(marker, group, 0.5);
    selfReach = { group, wedge };
  };

  const setHitboxes = (on: boolean) => {
    hitboxesOn = on;
    for (const obj of hitboxes) obj.visible = on;
  };

  /** Point the reach cone along the live aim; a use in flight glows brighter. */
  const updateReach = (dirX: number, dirY: number, attacking: boolean) => {
    if (!selfReach) return;
    if (dirX !== 0 || dirY !== 0) selfReach.wedge.rotation.y = Math.atan2(-dirY, dirX);
    (selfReach.wedge.material as THREE.MeshBasicMaterial).opacity = attacking ? 0.35 : 0.12;
  };

  const makeMarker = (name: string, color: number, style: string, self: boolean, facing: Facing, health: number, dead: boolean, respawnAt?: Stamp) => {
    const marker = new THREE.Group();
    const model = buildTrogg(style, color);
    model.root.position.set(0.5, 0, 0.5);
    model.root.rotation.y = facingYaw(facing);
    marker.add(model.root);
    model.actions.idle.legs.play();
    model.actions.idle.arms.play();
    if (dead) {
      setDowned(model, true);
      poseDead(model, 0.5, 0.24);
    }

    const overlays: Overlay[] = [];
    if (self) {
      // a bright ground ring under the feet so you can pick yourself out
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.36, 24), new THREE.MeshBasicMaterial({ color: UI_3D.parchment, transparent: true, opacity: 0.85 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0.5, 0.015, 0.5);
      marker.add(ring);
    }
    addHitbox(marker, hitRing(PLAYER_HIT_RADIUS, 0x6fdc9c), 0.5);
    if (self) addReach(marker);
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

  /** Point a creature at its motion and pick the gait action. The attack action
   *  overrides the gait for its duration, then hands back. */
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
    setGait(model, state, moving ? (running ? "run" : "walk") : "idle", attack);
  };

  /** Start (or continue) the one-shot attack action alongside the gait. The clip
   *  is the wield class of whatever the main hand holds — stab, chop, scoop, or
   *  the bare-fisted swing. */
  const driveAttack = (entry: Tracked, now: number) => {
    const phase = attackPhase(entry, now);
    if (phase !== undefined && entry.attackingBaseMs !== entry.equipmentActionBaseMs) {
      if (!entry.attacking) entry.model.actions[entry.gait].arms.fadeOut(0.05);
      entry.attacking?.stop();
      entry.attacking = entry.model.actions.attacks[wieldOf(entry.player.equippedMainHand)];
      entry.attackingBaseMs = entry.equipmentActionBaseMs;
      entry.attacking.reset().setDuration(ATTACK_PERIOD).fadeIn(0.05).play();
    } else if (phase === undefined && entry.attacking) {
      entry.attacking.fadeOut(0.1);
      entry.attacking = undefined;
      entry.attackingBaseMs = undefined;
      entry.model.actions[entry.gait].arms.reset().fadeIn(0.1).play();
    }
  };

  /** Per-frame trogg driver: gait + attack + flinch + respawn countdown + mixer. */
  const animate = (entry: Tracked, now: number, dt: number, motion: ProjectedMotion) => {
    if (entry.player.dead) {
      // a corpse lies still (poseDead holds — no steer, no gait, no flinch);
      // only the respawn countdown keeps ticking
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
      return;
    }
    const moving = motion.dirX !== 0 || motion.dirY !== 0;
    const faceX = moving ? motion.dirX : entry.player.faceX;
    const faceY = moving ? motion.dirY : entry.player.faceY;
    driveCreature(entry.model, entry, faceX, faceY, entry.player.running, dt, moving, entry.attacking !== undefined);
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
    for (const held of [entry.equip.mainHand, entry.equip.offHand]) {
      if (held?.fx) updateHeldFx(held.fx, now);
    }
    entry.model.mixer.update(dt);
    // Held-item arm poses (a torch carried aloft) land after the mixer has posed
    // the gait, so the pose wins over the swing for that arm.
    for (const held of [entry.equip.mainHand, entry.equip.offHand]) {
      if (held?.arm && held.fx?.armPitch !== undefined) held.arm.rotation.x = held.fx.armPitch;
    }
  };

  const makeGroundItem = (item: string) => {
    const marker = new THREE.Group();
    const glyph = buildGroundItem(item);
    if (glyph) {
      glyph.position.set(0.5, 0, 0.5);
      marker.add(glyph);
    }
    // The pickup sparkle: gold motes circling up over anything liftable — loot,
    // gathered yields, player drops alike — the "you can E this" signal. One
    // Points draw per item; animatePickupMotes drives it while visible.
    const positions = new Float32Array(PICKUP_MOTES * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    // depthTest off + a high renderOrder: the sparkle reads through the item
    // model, trees, and floor relief from any camera angle — visibility is its
    // entire job. Overlays (renderOrder 10) still draw above it.
    const material = new THREE.PointsMaterial({ color: UI_3D.gold, size: 0.12, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const motes = new THREE.Points(geo, material);
    motes.frustumCulled = false; // the buffer mutates per frame; the marker's visibility governs
    motes.renderOrder = 9;
    motes.userData.phase = Math.random() * 10;
    marker.add(motes);
    marker.userData.motes = motes;
    return marker;
  };

  /** Drive a ground item's pickup motes; call per frame while the marker is visible. */
  const animatePickupMotes = (marker: THREE.Group, now: number) => {
    const motes = marker.userData.motes as THREE.Points | undefined;
    if (!motes) return;
    const attr = motes.geometry.getAttribute("position") as THREE.BufferAttribute;
    const phase = motes.userData.phase as number;
    for (let i = 0; i < PICKUP_MOTES; i++) {
      const t = ((now / 1000) * 0.4 + phase + i / PICKUP_MOTES) % 1;
      const angle = phase * 7 + i * 2.4 + t * 2.5;
      attr.setXYZ(i, 0.5 + Math.cos(angle) * 0.17, 0.12 + t * 0.6, 0.5 + Math.sin(angle) * 0.17);
    }
    attr.needsUpdate = true;
    (motes.material as THREE.PointsMaterial).opacity = 0.75 + 0.2 * Math.sin(now * 0.004 + phase);
  };

  /** Sync the carried overlay (boulder) to the player row. */
  const applyCarry = (entry: Tracked) => {
    const kind = entry.player.carrying;
    if (kind === entry.carriedKind) return;
    if (entry.carried) disposeObject(entry.carried);
    entry.carried = undefined;
    entry.carriedKind = "";
    entry.carriedStyle = "";
    let overlay: THREE.Group | undefined;
    if (kind === "boulder") {
      overlay = buildBoulder();
      overlay.scale.setScalar(0.7);
    }
    if (!overlay) return;
    overlay.position.set(0, entry.model.height + 0.18, 0);
    // ride the body (not the marker) so the carry recoils with the flinch
    entry.model.root.add(overlay);
    entry.carried = overlay;
    entry.carriedKind = kind;
  };

  /** Sync held items to the equipped rows: parent each item model to the rig's hand
   *  node, so it rides the animated (swinging, striking) arm with no placement math. */
  const applyEquipment = (entry: Tracked) => {
    const slots: { slot: EquipSlot; item: string; hand: THREE.Group; armName: string }[] = [
      { slot: "mainHand", item: entry.player.equippedMainHand, hand: entry.model.handR, armName: "ArmR" },
      { slot: "offHand", item: entry.player.equippedOffHand, hand: entry.model.handL, armName: "ArmL" },
    ];
    for (const { slot, item, hand, armName } of slots) {
      const cur = entry.equip[slot];
      if (item === (cur?.kind ?? "")) continue;
      for (const child of [...hand.children]) disposeObject(child);
      delete entry.equip[slot];
      if (!item) continue;
      const model = buildHeldItem(item);
      if (!model) continue;
      model.scale.setScalar(entry.model.fit);
      hand.add(model);
      // Live behavior (light, flame cels, arm pose) comes from the item's own
      // HeldFx definition, shared verbatim with the dev preview.
      const fx = wireHeldFx(item, model);
      const arm = fx?.armPitch !== undefined ? (entry.model.root.getObjectByName(armName) ?? undefined) : undefined;
      entry.equip[slot] = { kind: item, fx, arm };
    }
    entry.torchLight = entry.equip.mainHand?.fx?.light ?? entry.equip.offHand?.fx?.light;
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

  /** Tear down a tracked trogg: timers, overlays, GPU resources. */
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

  /** Pop a floating damage number over a tile anchor (GDD "Combat"). The number
   *  anchors to the world, not the target, so a killing blow's number survives the
   *  target's row (and marker) vanishing. */
  const showDamage = (at: { x: number; z: number }, amount: number, headY: number) => {
    if (amount <= 0) return;
    const overlay = makeDamageText(amount);
    const jitter = (Math.random() - 0.5) * 0.5;
    overlay.sprite.position.set(at.x + 0.5 + jitter, headY + 0.45, at.z + 0.5);
    scene.add(overlay.sprite);
    damageFloats.push({ overlay, bornMs: performance.now(), from: overlay.sprite.position.clone() });
  };

  /** Advance ghost and damage-number timelines; call once per frame. */
  const updateGhosts = (now: number) => {
    for (let i = damageFloats.length - 1; i >= 0; i--) {
      const f = damageFloats[i]!;
      const t = (now - f.bornMs) / DAMAGE_FLOAT_MS;
      if (t >= 1) {
        scene.remove(f.overlay.sprite);
        f.overlay.dispose();
        damageFloats.splice(i, 1);
        continue;
      }
      const rise = 1 - (1 - t) * (1 - t); // ease-out: fast pop, slowing drift
      f.overlay.sprite.position.y = f.from.y + rise * DAMAGE_FLOAT_RISE;
      (f.overlay.sprite.material as THREE.SpriteMaterial).opacity = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
    }
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

  return { place, smoothPlace, headTop, makeMarker, animate, makeGroundItem, animatePickupMotes, applyCarry, applyEquipment, showBubble, showDamage, destroy, hauntGhost, updateGhosts, setHitboxes, updateReach };
}

export type Entities = ReturnType<typeof createEntities>;
