/**
 * Avatar paint helpers shared by the creature art modules in this folder: the bits
 * every creature reuses (feet, eyes), the legacy walk/run frame maths still used by
 * the baked hog rig (stride, foot lift, body bob, run lean), and `drawArm` for
 * rig-driven limbs.
 *
 * The skeleton/pose *data* (joint rest positions and the per-frame offsets that drive
 * gait and attack) lives in `shared/rig.ts` so the runtime can read the same joints;
 * this file only turns joints into pixels.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { dot, rect, shaded } from "../pixel_paint.ts";
import type { FrameName, PixelSink } from "../../shared/sprites.ts";

/** Which cardinal a frame is drawn for; `left` is the right profile, mirrored. */
export type View = "down" | "up" | "side";

/** Feet baseline (planted). */
export const FEET_Y = 40;

/** Forward hunch when running on the side profile (right-facing, pre-mirror). */
export const RUN_LEAN = 4;

export function isRun(frame: FrameName): boolean {
  return frame === "run_a" || frame === "run_b";
}

/** Which foot leads: +1 on `_a`, -1 on `_b`, 0 idle. Walk and run share the swing. */
export function stride(frame: FrameName): number {
  if (frame === "walk_a" || frame === "run_a") return 1;
  if (frame === "walk_b" || frame === "run_b") return -1;
  return 0;
}

/** Vertical foot lift for a stride frame; feet alternate, higher on a run. */
export function footLift(frame: FrameName, left: boolean): number {
  const lift = isRun(frame) ? -4 : -2;
  const s = stride(frame);
  if (s > 0) return left ? lift : 0;
  if (s < 0) return left ? 0 : lift;
  return 0;
}

/** Body bob as the avatar strides — 2px on a walk, 4px on a run's push-off. */
export function bodyBob(frame: FrameName): number {
  if (frame === "idle") return 0;
  return isRun(frame) ? -4 : -2;
}

/** Arm swing for a gait frame, matching the shared rig's hand offset (`stride × 3` walking,
 *  `× 5` running). Baked-limb creatures offset their painted arms by this so the drawn hand
 *  moves with the rig's hand joint — keeping a held item on the hand through the walk cycle. */
export function armSwing(frame: FrameName): number {
  return stride(frame) * (isRun(frame) ? 5 : 3);
}

/** Two feet with the walk lift applied; `y` is the planted baseline. */
export function feet(p: PixelSink, frame: FrameName, base: number, shade: number, y: number, lx: number, rx: number): void {
  shaded(p, lx, y + footLift(frame, true), 2.6, 2.1, base, shade);
  shaded(p, rx, y + footLift(frame, false), 2.6, 2.1, base, shade);
}

/** A round GSC eye: a tall dark oval with a single light highlight pixel. */
export function eye(p: PixelSink, x: number, y: number, dark: number, glint: number): void {
  rect(p, x, y, 2, 3, dark);
  dot(p, x, y, glint);
}

/** A run of shaded discs between two points. */
function limbRun(p: PixelSink, x0: number, y0: number, x1: number, y1: number, thickness: number, base: number, shade: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 1.2));
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    shaded(p, x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, thickness, thickness, base, shade);
  }
}

/** A limb drawn as two tapered runs through an elbow (shoulder→elbow→hand), so it reads as a
 *  bent arm rather than a straight capsule. The elbow sits at the midpoint, pushed perpendicular
 *  to the shoulder→hand line by `bend`; the default scales with length, so a long trogg arm
 *  hinges visibly while a stubby hog arm barely does. Driven by the shared skeleton/pose
 *  (`shared/rig.ts`), so moving the hand — a gait swing or an attack — flexes the whole arm. */
export function drawArm(p: PixelSink, x0: number, y0: number, x1: number, y1: number, thickness: number, base: number, shade: number, bend?: number): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const b = bend ?? len * 0.22; // elbow kick, perpendicular to the limb; backward/down by default
  const ex = (x0 + x1) / 2 + (-dy / len) * b;
  const ey = (y0 + y1) / 2 + (dx / len) * b;
  limbRun(p, x0, y0, ex, ey, thickness, base, shade); // upper arm
  limbRun(p, ex, ey, x1, y1, thickness, base, shade); // forearm
}
