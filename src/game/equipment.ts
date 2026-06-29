import { ANCHOR, FRAME_W, forward, gripRotation, slotAnchor, wieldPose, type EquipSlot, type Facing, type FrameName, type Kind } from "@trogg/shared";

/**
 * The single placement path for a main-hand item, shared by the live game
 * (`entities.ts`) and the dev preview (`src/preview`). Keeping the geometry in one
 * pure function is what guarantees every creature wields an item the same way: the
 * item is pinned to the rig's hand joint (so it rides the swinging — and on attack,
 * extending — arm), oriented by the directional art, mirrored for `left`, with the
 * per-item wield pose (hold→use eased across the attack) layered on top.
 */

/** Art pixels per tile — items are drawn at this and scaled up crisply (matches terrain). */
export const ART = 16;

/** Held-item frame suffix per facing: `_down`/`_up` are top-down views, `_side` the
 *  side profile (`left` mirrors it). */
export type HeldGroup = "_down" | "_up" | "_side";
const HELD_GROUP: Record<Facing, HeldGroup> = { down: "_down", up: "_up", left: "_side", right: "_side" };
export function heldGroup(facing: Facing): HeldGroup {
  return HELD_GROUP[facing];
}

/** Phase at which the strike lands — a quick wind-up, then a slower recovery follow-through. */
export const STRIKE_PEAK = 0.35;

/** The eased attack weight from raw use progress (0 = rest, 1 = full strike): a fast rise to
 *  the strike at `STRIKE_PEAK`, then an ease back out — so the swing snaps in and settles,
 *  rather than the old symmetric bump. Shared so game and preview match. */
export function attackEase(phase: number): number {
  if (phase <= 0 || phase >= 1) return 0;
  if (phase < STRIKE_PEAK) return Math.sin((phase / STRIKE_PEAK) * (Math.PI / 2)); // quick wind-up
  return Math.cos(((phase - STRIKE_PEAK) / (1 - STRIKE_PEAK)) * (Math.PI / 2)); // slower recovery
}

/** How long a hit-flinch (recoil + flash) plays. */
export const FLINCH_MS = 240;

/** A hit reaction over [0, FLINCH_MS): a recoil `shove` that eases out (0→1→0, applied opposite
 *  the facing) and a brief `flash` at the start. Null once finished. Shared by game and preview. */
export function flinchPose(elapsed: number): { shove: number; flash: boolean } | null {
  if (elapsed < 0 || elapsed >= FLINCH_MS) return null;
  const t = elapsed / FLINCH_MS;
  return { shove: Math.sin(t * Math.PI), flash: t < 0.35 };
}

/** Inputs for one frame's held-item placement. `attack` is the eased weight
 *  (0 = held/idle pose, 1 = full strike), e.g. `attackEase(progress)`. */
export interface HeldParams {
  kind: Kind;
  item: string;
  facing: Facing;
  frameName: FrameName;
  /** Live tile size in screen pixels. */
  tile: number;
  attack: number;
  /** Which hand holds it — defaults to the main hand. The off hand (e.g. a shield) pins to the
   *  off-hand anchor and sits behind the body on every facing but `down`. */
  slot?: EquipSlot;
}

/** Where and how a held item is drawn this frame, in the marker cell's local space
 *  (origin = cell top-left, feet anchor at the cell centre). */
export interface HeldTransform {
  /** Item-atlas frame to draw, e.g. `pickaxe_side`. */
  frame: string;
  x: number;
  y: number;
  rotation: number;
  /** Uniform scale, already including the wield pose's scale. */
  scale: number;
  /** Mirror horizontally (the side art is the right profile; `left` flips it). */
  flipX: boolean;
  /** Draw behind the body (the hand is behind it — facing up). */
  behind: boolean;
}

export function heldTransform(p: HeldParams): HeldTransform {
  const group = HELD_GROUP[p.facing];
  const sf = p.tile / FRAME_W; // sprite px → screen
  const feetY = p.tile / 2;
  const left = p.facing === "left";
  // The left avatar frame is baked as the mirror of the right one, so left = right, mirrored.
  // Source the pose from `right` and flip the result, rather than posing in left space (whose
  // `forward` is −x) and mirroring — which would throw the item the wrong way on the attack.
  const poseFacing: Facing = left ? "right" : p.facing;

  const hand = slotAnchor(p.kind, p.slot ?? "mainHand", poseFacing, p.frameName);
  const fx = left ? FRAME_W - 1 - hand.x : hand.x;
  const ax = p.tile / 2 + (fx - ANCHOR.x) * sf;
  const ay = feetY + (hand.y - ANCHOR.y) * sf;

  const pose = wieldPose(p.item, p.attack);
  const f = forward(p.facing); // screen direction of the facing (down = +y) — for reach/lift
  const side = left || p.facing === "right";
  // rotation only applies to side facings; down/up rely on the directional art. A grip tool uses
  // an explicit rotation per attack phase (raised wind-up, down-forward chop), authored so every
  // creature swings it the same way regardless of how its arm hangs. Without one the item keeps a
  // fixed orientation from its wield pose (the sword), carried by the arm's thrust.
  const gripRot = gripRotation(p.item, p.frameName);
  const rot = !side
    ? 0
    : (left ? -1 : 1) * (gripRot !== undefined ? gripRot : pose.rot);

  return {
    frame: `${p.item}${group}`,
    x: ax + f.x * pose.reach * p.tile,
    y: ay + f.y * pose.reach * p.tile - pose.lift * p.tile,
    rotation: rot,
    scale: (p.tile / ART) * pose.scale,
    flipX: left,
    behind: hand.behind,
  };
}
