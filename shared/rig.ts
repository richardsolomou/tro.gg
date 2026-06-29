/**
 * Creature skeleton/rig: where a creature's joints are and how they move, as data.
 *
 * One source of truth shared by the art generator (`tools/art/*`, which draws each
 * limb from shoulder/hip → hand/foot) and the runtime (`src/game/entities.ts`, which
 * anchors a held item to the same hand joint). Because a frame's *pose* is just a set
 * of per-joint offsets, gait (walk/run) and attack (wind-up/strike) are data, not
 * hardcoded per-creature animation — and a held item rides whatever the hand does.
 *
 * All coordinates are in 32×48 frame-pixel space (see `FRAME_W`/`FRAME_H`/`ANCHOR`).
 * Facings define `down`/`up`/`right`; `left` mirrors `right` (the side sprite is the
 * right profile, flipped). The main hand is the creature's right hand.
 */

import type { Facing, FrameName, Kind } from "./sprites";

export interface Joint {
  x: number;
  y: number;
}

/** The named joints a creature rig carries. */
export type JointName =
  | "mainShoulder"
  | "mainHand"
  | "offShoulder"
  | "offHand"
  | "nearHip"
  | "farHip"
  | "nearFoot"
  | "farFoot";

/** Every joint name — the canonical set to iterate (e.g. to draw the skeleton or guard bounds). */
export const JOINT_NAMES: readonly JointName[] = ["mainShoulder", "mainHand", "offShoulder", "offHand", "nearHip", "farHip", "nearFoot", "farFoot"];

/** Rest skeleton for one facing: every joint's neutral position plus whether the
 *  main arm (and its held item) sits behind the body for this facing. */
export interface FacingSkeleton {
  joints: Record<JointName, Joint>;
  behind: boolean;
}

/** Unit step in the direction a facing points, in frame space (down = +y). */
export function forward(facing: Facing): Joint {
  switch (facing) {
    case "down":
      return { x: 0, y: 1 };
    case "up":
      return { x: 0, y: -1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

// ── trogg skeleton ────────────────────────────────────────────────────────────
// Rest joints chosen to reproduce the silhouette painted in `tools/art/trogg.ts`:
// arms hang free outside a narrower torso, short bent legs in a wide stance.

const TROGG_FRONT: Record<JointName, Joint> = {
  mainShoulder: { x: 5, y: 23 },
  mainHand: { x: 5, y: 33 },
  offShoulder: { x: 27, y: 23 },
  offHand: { x: 27, y: 33 },
  nearHip: { x: 11.5, y: 35 },
  farHip: { x: 20.5, y: 35 },
  nearFoot: { x: 11, y: 40 },
  farFoot: { x: 21, y: 40 },
};

/** Up (back) view shares the front layout, but the main hand is the right one. */
const TROGG_BACK: Record<JointName, Joint> = {
  ...TROGG_FRONT,
  mainShoulder: { x: 27, y: 23 },
  mainHand: { x: 27, y: 33 },
  offShoulder: { x: 5, y: 23 },
  offHand: { x: 5, y: 33 },
};

/** Right profile: the near (main) arm in front, the far (off) arm behind. */
const TROGG_SIDE: Record<JointName, Joint> = {
  mainShoulder: { x: 19, y: 24 },
  mainHand: { x: 20, y: 34 },
  offShoulder: { x: 12, y: 24 },
  offHand: { x: 12, y: 34 },
  nearHip: { x: 18, y: 36 },
  farHip: { x: 13, y: 36 },
  nearFoot: { x: 18.5, y: 40 },
  farFoot: { x: 13, y: 40 },
};

const TROGG_SKELETON: Record<Facing, FacingSkeleton> = {
  down: { joints: TROGG_FRONT, behind: false },
  up: { joints: TROGG_BACK, behind: true },
  right: { joints: TROGG_SIDE, behind: false },
  left: { joints: TROGG_SIDE, behind: false },
};

// ── hog skeleton ────────────────────────────────────────────────────────────────
// The round hedgehog body (shared by classic/snow/ember). Hands sit on the little paw
// stubs painted in `tools/art/hog.ts` — front paws low at the sides, one near paw on the
// side profile. Smaller and higher than the trogg. The big/costume hogs (buff/dino/
// chicken) have very different bodies and still borrow this until they get their own.

const HOG_FRONT: Record<JointName, Joint> = {
  mainShoulder: { x: 6, y: 30 },
  mainHand: { x: 5, y: 33 },
  offShoulder: { x: 25, y: 30 },
  offHand: { x: 26, y: 33 },
  nearHip: { x: 12, y: 36 },
  farHip: { x: 19, y: 36 },
  nearFoot: { x: 12, y: 40 },
  farFoot: { x: 19, y: 40 },
};

/** Up (back) view shares the front layout, but the main (right) hand swaps to the far side. */
const HOG_BACK: Record<JointName, Joint> = {
  ...HOG_FRONT,
  mainShoulder: { x: 25, y: 30 },
  mainHand: { x: 26, y: 33 },
  offShoulder: { x: 6, y: 30 },
  offHand: { x: 5, y: 33 },
};

/** Right profile: the near paw (`hogArm` at ~19,31) holds the item. */
const HOG_SIDE: Record<JointName, Joint> = {
  mainShoulder: { x: 17, y: 30 },
  mainHand: { x: 20, y: 32 },
  offShoulder: { x: 13, y: 30 },
  offHand: { x: 12, y: 32 },
  nearHip: { x: 17, y: 36 },
  farHip: { x: 13, y: 36 },
  nearFoot: { x: 17, y: 40 },
  farFoot: { x: 13, y: 40 },
};

const HOG_SKELETON: Record<Facing, FacingSkeleton> = {
  down: { joints: HOG_FRONT, behind: false },
  up: { joints: HOG_BACK, behind: true },
  right: { joints: HOG_SIDE, behind: false },
  left: { joints: HOG_SIDE, behind: false },
};

function skeleton(kind: Kind): Record<Facing, FacingSkeleton> {
  return kind === "trogg" ? TROGG_SKELETON : HOG_SKELETON;
}

/** Rest skeleton for a kind + facing. */
export function skeletonFor(kind: Kind, facing: Facing): FacingSkeleton {
  return skeleton(kind)[facing];
}

// ── pose clips (the animation, as data) ─────────────────────────────────────────
// Per-frame offset applied to each joint. Gait matches the legacy `sw`/`footLift`/
// `bodyBob` so the walk/run look is preserved; attack throws the main hand.

function isRun(frame: FrameName): boolean {
  return frame === "run_a" || frame === "run_b";
}

/** Leading/trailing stride sign: +1 on `_a`, −1 on `_b`, 0 otherwise. */
function stride(frame: FrameName): number {
  if (frame === "walk_a" || frame === "run_a") return 1;
  if (frame === "walk_b" || frame === "run_b") return -1;
  return 0;
}

/** Body bob: the whole creature dips as it strides (the off-foot stays planted). */
export function rootBob(frame: FrameName): number {
  if (frame === "idle" || frame === "attack_a" || frame === "attack_b") return 0;
  return isRun(frame) ? -4 : -2;
}

/** Vertical foot lift for a stride frame; near/far alternate, higher on a run. */
function footLift(frame: FrameName, near: boolean): number {
  if (frame === "attack_a" || frame === "attack_b") return 0;
  const lift = isRun(frame) ? -4 : -2;
  const s = stride(frame);
  if (s > 0) return near ? lift : 0;
  if (s < 0) return near ? 0 : lift;
  return 0;
}

/** Reach distances. Wind-up cocks the hand back; the strike throws it forward. Kept short so the
 *  drawn limb stays a connected extension of the arm rather than stretching off the body. */
const ATTACK_COCK = 3;
const ATTACK_REACH = 5;

/** The per-frame offset of one joint from its rest position, in frame pixels. Both the gait swing
 *  and the attack reach are shared by every rig-driven kind, so hog arms swing while walking and
 *  reach on a strike just like the trogg's (the main arm cocks back on `attack_a`, throws forward
 *  on `attack_b`); the body and other limbs hold through the attack. */
export function poseOffset(kind: Kind, facing: Facing, frame: FrameName, joint: JointName): Joint {
  const b = rootBob(frame);
  const run = isRun(frame);
  const sw = stride(frame) * (run ? 5 : 3); // arm swing — bigger than the leg stride
  const side = facing === "left" || facing === "right";

  if (frame === "attack_a" || frame === "attack_b") {
    // only the main arm moves; the body and other limbs hold
    if (joint === "mainHand" || joint === "mainShoulder") {
      // The hand reaches back on the wind-up, forward on the strike, along the facing — a neutral
      // arm motion shared by every weapon. Each weapon's own character (the pickaxe's overhead
      // chop, the shovel's low dig, the sword's flat thrust) comes from its tool rotation
      // (`gripRotation`) and art, not from a per-weapon arm path. The shoulder stays planted on the
      // torso so the arm pivots from the body rather than lifting its root off.
      if (joint === "mainShoulder") return { x: 0, y: b };
      const f = forward(facing);
      const along = frame === "attack_b" ? ATTACK_REACH : -ATTACK_COCK;
      return { x: f.x * along, y: f.y * along };
    }
    return { x: 0, y: 0 };
  }

  switch (joint) {
    // Shoulders are the arm's pivot — they stay on the (bobbing) torso while the hands swing.
    case "mainShoulder":
    case "offShoulder":
      return { x: 0, y: b };
    case "mainHand":
      return side ? { x: sw, y: b } : { x: 0, y: b + sw };
    case "offHand":
      return side ? { x: -sw, y: b } : { x: 0, y: b - sw };
    case "nearHip":
    case "farHip":
      return { x: 0, y: b };
    case "nearFoot":
      return { x: 0, y: footLift(frame, true) };
    case "farFoot":
      return { x: 0, y: footLift(frame, false) };
  }
}

/** A joint's posed position = rest + this frame's offset. */
export function jointAt(kind: Kind, facing: Facing, frame: FrameName, joint: JointName): Joint {
  const rest = skeletonFor(kind, facing).joints[joint];
  const off = poseOffset(kind, facing, frame, joint);
  return { x: rest.x + off.x, y: rest.y + off.y };
}

/** An equippable attachment slot — where a held item (and, later, a worn layer) pins to the
 *  body. `mainHand` holds a tool or weapon; `offHand` holds a shield or second tool. The armour
 *  slots (head/chest/…) are added with their first layer — see the layered-avatar design in the
 *  GDD. The slot vocabulary is the cross-species contract: every creature's rig resolves the same
 *  slots, so any slot-targeted item can attach to any creature. */
export type EquipSlot = "mainHand" | "offHand";

/** The anchor for an equip slot this frame: the slot's hand joint plus whether it draws behind
 *  the body. The cross-slot generalisation of `handJoint` — the seam the layered-equipment
 *  system pins to. The main (near) hand sits in front except when facing away; the off (far)
 *  hand sits behind the body on every facing but `down` (where both hands are toward the camera). */
export function slotAnchor(kind: Kind, slot: EquipSlot, facing: Facing, frame: FrameName): Joint & { behind: boolean } {
  const j = jointAt(kind, facing, frame, slot === "mainHand" ? "mainHand" : "offHand");
  const behind = slot === "offHand" ? facing !== "down" : skeletonFor(kind, facing).behind;
  return { x: j.x, y: j.y, behind };
}

/** The main-hand anchor — the slot the current wielding/`heldTransform` path pins to. */
export function handJoint(kind: Kind, facing: Facing, frame: FrameName): Joint & { behind: boolean } {
  return slotAnchor(kind, "mainHand", facing, frame);
}

/** The main arm's screen angle (radians): atan2 of shoulder→hand — the direction of the drawn
 *  forearm this frame. A held item rotated to this reads as a rigid extension of the arm, so it
 *  swings exactly with the arm (same pivot, same timing) rather than on its own curve. */
export function armAngle(kind: Kind, facing: Facing, frame: FrameName): number {
  const s = jointAt(kind, facing, frame, "mainShoulder");
  const h = jointAt(kind, facing, frame, "mainHand");
  return Math.atan2(h.y - s.y, h.x - s.x);
}

// ── wield profiles ────────────────────────────────────────────────────────────
// How an equippable is *held* (idle/carry) versus *used* (the attack peak), layered on
// top of the rig's hand joint and the body's attack reach. One profile per item, so a
// pickaxe rests low and chops high while a shovel digs downward, with no per-creature
// code. The runtime eases hold→use across the attack.

export interface WieldPose {
  /** Extra rotation (radians) of the item, applied on side facings (mirrored for left);
   *  down/up rely on the directional art instead. Positive tips the business end down. */
  rot: number;
  /** Shift along the facing-forward direction, in tile fractions. */
  reach: number;
  /** Shift toward screen-up, in tile fractions; negative rides lower in the hand. */
  lift: number;
  /** Size multiplier. */
  scale: number;
}

export interface WieldProfile {
  hold: WieldPose;
  use: WieldPose;
}

const NEUTRAL: WieldPose = { rot: 0, reach: 0, lift: 0, scale: 1 };

/** Per-item tuning. Two ways an item is oriented on the side facings:
 *   - `swing` set → an **explicit rotation (radians) per attack phase**: a resting tilt, a raised
 *     wind-up, and a down-forward chop. Authored, not derived from the forearm, so the tool raises
 *     and chops the same way on every creature no matter how its arm hangs (a near-vertical trogg
 *     arm and a diagonal hog arm both swing it identically).
 *   - no `swing` → a fixed orientation from the `hold`/`use` `rot` (e.g. the sword points along
 *     the facing and the arm thrust carries it).
 *  `hold`/`use` `lift`/`reach`/`scale` (partials over `NEUTRAL`) still ease across the attack. */
const WIELD: Record<string, { hold?: Partial<WieldPose>; use?: Partial<WieldPose>; swing?: { rest: number; windup: number; strike: number } }> = {
  // sword: no swing and no hold→use offset — fixed orientation, rides the hand joint so the arm's
  // thrust carries it and the drawn arm and blade stay locked together.
  // pickaxe: raises overhead on the wind-up, then chops down-forward.
  pickaxe: { swing: { rest: 0.3, windup: -1.7, strike: 0.9 } },
  // shovel: stays low to the ground — blade angled down throughout, digging down-forward on the
  // strike rather than swinging overhead.
  shovel: { swing: { rest: 1.0, windup: 0.7, strike: 1.55 } },
};

/** The full hold/use profile for an item id, defaults filled in. */
export function wieldProfile(item: string): WieldProfile {
  const e = WIELD[item];
  return { hold: { ...NEUTRAL, ...(e?.hold ?? {}) }, use: { ...NEUTRAL, ...(e?.use ?? {}) } };
}

/** A grip tool's explicit side-facing rotation (radians) for this frame: a resting tilt, a raised
 *  wind-up (`attack_a`), and a down-forward chop (`attack_b`). `undefined` for fixed-orientation
 *  items (the sword), which use the `hold`/`use` `rot` instead. Authored per phase rather than
 *  derived from the forearm, so the swing reads the same on every creature. */
export function gripRotation(item: string, frame: FrameName): number | undefined {
  const s = WIELD[item]?.swing;
  if (!s) return undefined;
  if (frame === "attack_a") return s.windup;
  if (frame === "attack_b") return s.strike;
  return s.rest;
}

/** The item's pose at attack ease `k` (0 = held/idle, 1 = full strike), lerped hold→use.
 *  Returns the exact endpoint pose at the bounds (no float drift). */
export function wieldPose(item: string, k: number): WieldPose {
  const { hold, use } = wieldProfile(item);
  if (k <= 0) return hold;
  if (k >= 1) return use;
  const mix = (a: number, b: number) => a + (b - a) * k;
  return { rot: mix(hold.rot, use.rot), reach: mix(hold.reach, use.reach), lift: mix(hold.lift, use.lift), scale: mix(hold.scale, use.scale) };
}
