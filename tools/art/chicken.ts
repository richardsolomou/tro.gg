/**
 * Chicken hog art (easter egg): a hedgehog in a chicken costume — cream body,
 * red comb, a beak, side wings, the hog face under it, orange feet, a russet
 * tail (ref: costume.png). Normal 1×1 size; summoned, never seeded.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, rect, shaded } from "../pixel_paint.ts";
import { bodyBob, footLift, FEET_Y, type View } from "./rig.ts";
import type { FrameName, PixelSink } from "../../shared/sprites.ts";

export const CHICK = {
  out: 0x2a2018,
  body: 0xf2ecdd,
  bodyDk: 0xd2c8b4,
  comb: 0xd0442a,
  beak: 0xe6a62d,
  beakDk: 0xc6861a,
  tail: 0xb4541f,
  face: 0xf0dcab,
  faceDk: 0xcdac72,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

export function chickenDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = CHICK;
  const b = bodyBob(frame);
  shaded(p, 13, FEET_Y + footLift(frame, true), 2, 1.8, c.beak, c.beakDk);
  shaded(p, 19, FEET_Y + footLift(frame, false), 2, 1.8, c.beak, c.beakDk);

  if (view === "up") {
    shaded(p, 15.5, 27 + b, 10, 9, c.body, c.bodyDk);
    disc(p, 6, 33 + b, 2.6, 2.2, c.tail); disc(p, 4.6, 31 + b, 2, 1.8, c.tail);
    rect(p, 14, 9 + b, 3, 2, c.comb);
    return;
  }

  // russet tail behind
  shaded(p, 5, 29 + b, 3, 3.4, c.tail, c.beakDk);
  // body
  shaded(p, 15.5, 28 + b, 10, 9, c.body, c.bodyDk);
  // wings at the sides
  shaded(p, 6.5, 27 + b, 2.6, 4, c.body, c.bodyDk);
  shaded(p, 24.5, 27 + b, 2.6, 4, c.body, c.bodyDk);
  // comb
  disc(p, 13.5, 10 + b, 1.6, 2, c.comb); disc(p, 15.5, 9 + b, 1.8, 2.4, c.comb); disc(p, 17.5, 10 + b, 1.6, 2, c.comb);
  // hog face under a beak
  shaded(p, 15.5, 17 + b, 5, 4.2, c.face, c.faceDk);
  rect(p, 12.5, 16 + b, 2, 2, c.eye); rect(p, 17.5, 16 + b, 2, 2, c.eye);
  dot(p, 12.5, 16 + b, 0xffffff); dot(p, 17.5, 16 + b, 0xffffff);
  // beak
  disc(p, 15.5, 19.5 + b, 2.4, 1.4, c.beak);
  dot(p, 15.5, 20.2 + b, c.beakDk);
  if (view === "side") disc(p, 21, 18 + b, 2.4, 1.4, c.beak);
}
