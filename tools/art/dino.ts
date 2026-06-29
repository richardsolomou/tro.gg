/**
 * Dino hog art: a hedgehog in a T-rex costume — green scaly body, a toothy open
 * hood with the hog face inside, a spiky back ridge, a tail, little arms (ref:
 * angry.png). A big 2×2 showpiece rendered at double size.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, rect, shaded } from "../pixel_paint.ts";
import { bodyBob, drawArm, feet, FEET_Y, type View } from "./rig.ts";
import { jointAt, skeletonFor, type JointName } from "../../shared/rig.ts";
import type { Facing, FrameName, PixelSink } from "../../shared/sprites.ts";

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

/** One costume arm from the shared rig: a green limb to the hand plus a fist, so it swings with
 *  the gait and reaches on attack off the same hand joint a held item rides. */
function dinoArmRig(p: PixelSink, facing: Facing, frame: FrameName, slot: "main" | "off"): void {
  const c = DINO;
  const sh = jointAt("hog", facing, frame, slot === "main" ? "mainShoulder" : "offShoulder");
  const hd = jointAt("hog", facing, frame, slot === "main" ? "mainHand" : "offHand");
  drawArm(p, sh.x, sh.y, hd.x, hd.y, 2.2, c.body, c.bodyDk);
  shaded(p, hd.x, hd.y, 2.3, 2.3, c.body, c.bodyDk); // fist
}

/** The dino hog minus its in-front main arm. `dinoDraw` adds the main arm on top; the generator
 *  paints body and arm apart for the near-arm-over-item overlay. */
export function dinoBody(p: PixelSink, view: View, frame: FrameName): void {
  const c = DINO;
  const facing: Facing = view === "side" ? "right" : view;
  const b = bodyBob(frame);
  const behind = skeletonFor("hog", facing).behind;
  feet(p, frame, c.body, c.out, FEET_Y, 11, 20);
  shaded(p, 12, 35 + b, 3.6, 4.6, c.body, c.bodyDk);
  shaded(p, 19, 35 + b, 3.6, 4.6, c.body, c.bodyDk);

  if (view === "up") {
    // back: ridge crest high (matching the front silhouette), the hood's back, body, spine, both arms
    dinoRidge(p, 15.5, 10 + b, 8, c);
    shaded(p, 15.5, 16 + b, 6.6, 5, c.body, c.bodyDk);
    shaded(p, 15.5, 28 + b, 11, 9, c.body, c.bodyDk);
    rect(p, 14, 20 + b, 3, 12, c.bodyDk);
    dinoArmRig(p, facing, frame, "off");
    dinoArmRig(p, facing, frame, "main"); // behind the body when facing away
    return;
  }

  if (view === "side") {
    // profile at the same height as the front: body, a ridge running down the back from behind
    // the head, the toothy hood up front with the hog face inside
    shaded(p, 14, 28 + b, 8, 9, c.body, c.bodyDk);
    for (let i = 0; i < 4; i++) disc(p, 16 - i * 2.4, 16 + i * 2.6 + b, 1.4, 1.8, c.bodyDk); // back ridge down the spine
    disc(p, 16, 30 + b, 5, 4, c.belly);
    shaded(p, 22, 16 + b, 6.4, 6, c.body, c.bodyDk); // toothy hood
    rect(p, 18, 18 + b, 12, 1, c.out); // jaw line
    for (let x = 18; x <= 28; x += 2) { dot(p, x, 16 + b, c.tooth); dot(p, x + 1, 20 + b, c.tooth); }
    disc(p, 23, 19 + b, 2.6, 2.2, c.face); // hog face inside
    dot(p, 24, 18.5 + b, c.eye);
    dot(p, 25.5, 12.5 + b, c.eye); // costume eye high on the snout
    return; // the near arm is drawn on top by dinoDraw / as the overlay
  }

  // front: scaly body, belly, ridge, off arm, toothy hood, hog face (main arm rides on top)
  dinoRidge(p, 15.5, 9 + b, 8, c);
  shaded(p, 15.5, 29 + b, 11, 9, c.body, c.bodyDk);
  disc(p, 15.5, 31 + b, 6, 5.2, c.belly);
  dinoArmRig(p, facing, frame, "off");
  if (behind) dinoArmRig(p, facing, frame, "main");
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

/** The dino hog's in-front main arm, drawn over a held item. Empty when it tucks behind (up). */
export function dinoMainArm(p: PixelSink, view: View, frame: FrameName): void {
  const facing: Facing = view === "side" ? "right" : view;
  if (skeletonFor("hog", facing).behind) return;
  dinoArmRig(p, facing, frame, "main");
}

export function dinoDraw(p: PixelSink, view: View, frame: FrameName): void {
  dinoBody(p, view, frame);
  dinoMainArm(p, view, frame);
}
