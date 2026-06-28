/**
 * Buff hog art: a swole hedgehog standing ready — tan muscle, pecs and ab lines,
 * a quill mane, a tiny smug face. Arms hang at its sides (fists on the hog rig's
 * hand joints) so it can wield, with a real side profile. A big 2×2 showpiece
 * authored at the shared frame size and rendered at double size.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, line, rect, shaded } from "../pixel_paint.ts";
import { armSwing, bodyBob, feet, FEET_Y, type View } from "./rig.ts";
import { quillSpikes } from "./hog.ts";
import type { FrameName, PixelSink } from "../../shared/sprites.ts";

export const BUFF = {
  out: 0x241a0e,
  skin: 0xd2a96f,
  skinDk: 0x9c7438,
  face: 0xf0dcab,
  quill: 0x7c5c37,
  quillDk: 0x503b22,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

export function buffDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = BUFF;
  const b = bodyBob(frame);
  const sw = armSwing(frame); // arms swing with the gait, matching the rig hand
  feet(p, frame, c.skin, c.out, FEET_Y, 11, 20);
  shaded(p, 12, 35 + b, 3.4, 4.4, c.skin, c.skinDk);
  shaded(p, 19, 35 + b, 3.4, 4.4, c.skin, c.skinDk);

  if (view === "up") {
    // back: mane crown, broad muscular back with a spine groove, arms hanging at the sides
    disc(p, 15.5, 13 + b, 5.6, 4.2, c.quill);
    quillSpikes(p, 15.5, 13.5 + b, 5.6, 3.4, c.quill);
    shaded(p, 15.5, 27 + b, 11, 9, c.skin, c.skinDk);
    rect(p, 14, 18 + b, 3, 13, c.skinDk);
    shaded(p, 6, 31 + b + sw, 2.8, 3.6, c.skin, c.skinDk);
    shaded(p, 25, 31 + b - sw, 2.8, 3.6, c.skin, c.skinDk);
    return;
  }

  if (view === "side") {
    // right profile: muscular torso side-on, near arm hanging to its fist on the rig joint,
    // head leaning forward under the mane
    shaded(p, 14, 28 + b, 7.2, 8, c.skin, c.skinDk); // torso
    disc(p, 16, 27 + b, 3, 2.8, c.skin); // near pec
    line(p, 12, 31 + b, 18, 31 + b, c.skinDk); // ab hint
    disc(p, 16, 14 + b, 4.6, 3.6, c.quill);
    quillSpikes(p, 15, 14 + b, 4.8, 3.2, c.quill);
    shaded(p, 20, 18 + b, 3.6, 3.4, c.face, c.skinDk); // jutting muzzle
    rect(p, 21, 17 + b, 2, 2, c.eye); dot(p, 21, 17 + b, 0xffffff);
    dot(p, 23, 19 + b, c.nose);
    shaded(p, 18 + sw * 0.5, 26 + b, 2.8, 3, c.skin, c.skinDk); // near upper arm
    shaded(p, 20 + sw, 31 + b, 2.6, 2.8, c.skin, c.skinDk); // near fist swings forward/back (~hog side hand 20,32)
    return;
  }

  // front: muscular chest + abs, mane, smug face, arms hanging at the sides so it can wield
  shaded(p, 15.5, 27 + b, 11.2, 8.4, c.skin, c.skinDk); // chest/torso
  disc(p, 11, 25 + b, 3.2, 2.6, c.skin); disc(p, 20, 25 + b, 3.2, 2.6, c.skin); // pecs
  line(p, 15.5, 25 + b, 15.5, 34 + b, c.skinDk);
  line(p, 11, 29 + b, 20, 29 + b, c.skinDk);
  line(p, 11, 32 + b, 20, 32 + b, c.skinDk);
  // arms hang at the sides: deltoid, upper arm, fist on the hog hand joints (5,33)/(26,33)
  for (const s of [-1, 1] as const) {
    const sx = 15.5 + s * 9;
    const dy = -s * sw; // main (screen-left) drops as the off arm rises, swapping each step
    shaded(p, sx, 24 + b, 3, 3.6, c.skin, c.skinDk); // deltoid (shoulder pivot)
    shaded(p, sx + s * 0.8, 29 + b + dy * 0.5, 2.6, 3, c.skin, c.skinDk); // upper arm
    shaded(p, 15.5 + s * 10.5, 33 + b + dy, 2.6, 2.6, c.skin, c.skinDk); // fist
  }
  // quill mane on the crown
  disc(p, 15.5, 13 + b, 5, 3.6, c.quill);
  quillSpikes(p, 15.5, 13.5 + b, 5, 3.4, c.quill);
  // smug face below the mane
  shaded(p, 15.5, 18 + b, 4.8, 4, c.face, c.skinDk);
  rect(p, 13, 17 + b, 2, 2, c.eye); rect(p, 17, 17 + b, 2, 2, c.eye);
  dot(p, 13, 17 + b, 0xffffff); dot(p, 17, 17 + b, 0xffffff);
  dot(p, 15.5, 19 + b, c.nose);
  line(p, 13.6, 20.5 + b, 17.4, 20.5 + b, c.out);
}
