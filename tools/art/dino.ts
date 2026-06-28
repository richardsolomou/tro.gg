/**
 * Dino hog art: a hedgehog in a T-rex costume — green scaly body, a toothy open
 * hood with the hog face inside, a spiky back ridge, a tail, little arms (ref:
 * angry.png). A big 2×2 showpiece rendered at double size.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, rect, shaded } from "../pixel_paint.ts";
import { bodyBob, feet, FEET_Y, type View } from "./rig.ts";
import type { FrameName, PixelSink } from "../../shared/sprites.ts";

export const DINO = {
  out: 0x16240e,
  body: 0x7a9038,
  bodyDk: 0x4d6020,
  belly: 0xcfca7e,
  tooth: 0xf3eedf,
  face: 0xf0dcab,
  faceDk: 0xcdac72,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

/** Sawtooth ridge plates along the costume's back, outlined later into spikes. */
function dinoRidge(p: PixelSink, cx: number, top: number, span: number, c: typeof DINO): void {
  for (let x = cx - span; x <= cx + span; x += 3) disc(p, x, top, 1.4, 1.8, c.bodyDk);
}

export function dinoDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = DINO;
  const b = bodyBob(frame);
  feet(p, frame, c.body, c.out, FEET_Y, 11, 20);
  shaded(p, 12, 35 + b, 3.6, 4.6, c.body, c.bodyDk);
  shaded(p, 19, 35 + b, 3.6, 4.6, c.body, c.bodyDk);

  if (view === "up") {
    dinoRidge(p, 15.5, 17 + b, 8, c);
    shaded(p, 15.5, 27 + b, 11, 9.4, c.body, c.bodyDk);
    rect(p, 14, 19 + b, 3, 11, c.bodyDk);
    shaded(p, 4, 32 + b, 4, 2.6, c.body, c.bodyDk);
    return;
  }

  if (view === "side") {
    shaded(p, 5, 31 + b, 5.4, 3, c.body, c.bodyDk);
    dinoRidge(p, 14, 19 + b, 5, c);
    shaded(p, 15, 27 + b, 9, 8, c.body, c.bodyDk);
    disc(p, 16, 30 + b, 5, 4, c.belly);
    shaded(p, 23, 21 + b, 6.4, 5.4, c.body, c.bodyDk);
    rect(p, 18, 23 + b, 12, 1, c.out);
    for (let x = 18; x <= 28; x += 2) { dot(p, x, 21 + b, c.tooth); dot(p, x + 1, 25 + b, c.tooth); }
    disc(p, 23, 24 + b, 2.6, 2.2, c.face);
    dot(p, 24, 23.5 + b, c.eye);
    dot(p, 25.5, 16.5 + b, c.eye);
    // near arm reaching down to the wielding hand (~hog side hand 20,32)
    shaded(p, 18, 26 + b, 2, 3, c.body, c.bodyDk);
    shaded(p, 20, 31 + b, 2.3, 2.3, c.body, c.bodyDk);
    return;
  }

  // front: scaly body, belly, ridge, arms to the rig hands, toothy hood, hog face
  dinoRidge(p, 15.5, 9 + b, 8, c);
  shaded(p, 15.5, 29 + b, 11, 9, c.body, c.bodyDk);
  disc(p, 15.5, 31 + b, 6, 5.2, c.belly);
  // arms reaching down to fists on the hog hand joints (5,33)/(26,33), so it can wield
  shaded(p, 7, 28 + b, 2.2, 3, c.body, c.bodyDk); shaded(p, 5, 33 + b, 2.3, 2.3, c.body, c.bodyDk);
  shaded(p, 24, 28 + b, 2.2, 3, c.body, c.bodyDk); shaded(p, 26, 33 + b, 2.3, 2.3, c.body, c.bodyDk);
  // toothy hood framing the face
  shaded(p, 15.5, 16 + b, 9, 6.8, c.body, c.bodyDk);
  rect(p, 11, 12 + b, 2, 2, c.eye); rect(p, 19, 12 + b, 2, 2, c.eye);
  rect(p, 7, 19 + b, 17, 1, c.out);
  for (let x = 8; x <= 22; x += 2) dot(p, x, 18 + b, c.tooth);
  // hog face peeking out
  shaded(p, 15.5, 21 + b, 4.4, 3.4, c.face, c.faceDk);
  rect(p, 13, 20 + b, 2, 2, c.eye); rect(p, 17, 20 + b, 2, 2, c.eye);
  dot(p, 13, 20 + b, 0xffffff); dot(p, 17, 20 + b, 0xffffff);
  dot(p, 15.5, 22 + b, c.nose);
}
