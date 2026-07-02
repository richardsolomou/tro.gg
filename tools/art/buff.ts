/**
 * Buff hog art: a swole hedgehog standing ready — tan muscle, pecs and ab lines,
 * a quill mane, a tiny smug face. Arms hang at its sides (fists on the hog rig's
 * hand joints) so it can wield, with a real side profile. A big 2×2 showpiece
 * authored at the shared frame size and rendered at double size.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, line, rect, shaded, translated } from "../pixel_paint.ts";
import { drawArm, feet, FEET_Y, type View } from "./rig.ts";
import { quillSpikes } from "./hog.ts";
import { bodyLean, jointAt, rootBob, skeletonFor, type JointName } from "../../shared/rig.ts";
import type { Facing, FrameName, PixelSink } from "../../shared/sprites.ts";

export const BUFF = {
  out: 0x1c1208,
  skin: 0xd89850,
  skinHi: 0xffd890,
  skinDk: 0x8c541c,
  face: 0xf8d88a,
  quill: 0x8a5a2e,
  quillHi: 0xb8783c,
  quillDk: 0x4a2d14,
  nose: 0x2c1808,
  eye: 0x100804,
} as const;

/** One swole arm from the shared rig: a deltoid cap at the shoulder, a muscular limb to the
 *  hand, and a fist — so it swings with the gait and a held item rides the fist. */
function buffArmRig(p: PixelSink, facing: Facing, frame: FrameName, slot: "main" | "off", handDy = 0): void {
  const c = BUFF;
  const sh = jointAt("hog", facing, frame, slot === "main" ? "mainShoulder" : "offShoulder");
  const hd = jointAt("hog", facing, frame, slot === "main" ? "mainHand" : "offHand");
  const hy = hd.y + handDy;
  shaded(p, sh.x, sh.y - 1, 3, 3.4, c.skin, c.skinDk); // deltoid (shoulder cap)
  dot(p, sh.x - 1, sh.y - 3, c.skinHi);
  drawArm(p, sh.x, sh.y, hd.x, hy, 2.8, c.skin, c.skinDk);
  shaded(p, hd.x, hy, 2.6, 2.6, c.skin, c.skinDk); // fist
  dot(p, hd.x - 1, hy - 1, c.skinHi);
}

/** The buff hog minus its in-front main arm. The wrapper `buffDraw` adds the main arm on top;
 *  the generator paints body and arm apart for the near-arm-over-item overlay. */
export function buffBody(p: PixelSink, view: View, frame: FrameName): void {
  const c = BUFF;
  const facing: Facing = view === "side" ? "right" : view;
  const b = rootBob(frame); // the rig's bob, so the body dips exactly with the rig-driven arms
  const behind = skeletonFor("hog", facing).behind;
  feet(p, "hog", facing, frame, c.skin, c.out, FEET_Y, view === "side" ? 20 : 11, view === "side" ? 11 : 20);
  shaded(p, 12, 35 + b, 3.4, 4.4, c.skin, c.skinDk);
  shaded(p, 19, 35 + b, 3.4, 4.4, c.skin, c.skinDk);

  if (view === "up") {
    // back: mane crown, broad muscular back with a spine groove, arms hanging at the sides
    disc(p, 15.5, 13 + b, 5.6, 4.2, c.quill);
    quillSpikes(p, 15.5, 13.5 + b, 5.6, 3.4, c.quill);
    rect(p, 12, 11 + b, 5, 1, c.quillHi);
    shaded(p, 15.5, 27 + b, 11, 9, c.skin, c.skinDk);
    rect(p, 10, 22 + b, 5, 1, c.skinHi);
    rect(p, 14, 18 + b, 3, 13, c.skinDk);
    buffArmRig(p, facing, frame, "off");
    buffArmRig(p, facing, frame, "main"); // behind the body when facing away
    return;
  }

  if (view === "side") {
    // right profile: muscular torso side-on, head leaning forward under the mane.
    // The body group leans through a shifted sink, matching the rig's arm lean.
    const q = translated(p, bodyLean("hog", facing, frame), 0);
    shaded(q, 14, 28 + b, 7.2, 8, c.skin, c.skinDk); // torso
    disc(q, 16, 27 + b, 3, 2.8, c.skinHi); // near pec
    line(q, 12, 31 + b, 18, 31 + b, c.skinDk); // ab hint
    disc(q, 16, 14 + b, 4.6, 3.6, c.quill);
    quillSpikes(q, 15, 14 + b, 4.8, 3.2, c.quill);
    rect(q, 13, 12 + b, 5, 1, c.quillHi);
    shaded(q, 20, 18 + b, 3.6, 3.4, c.face, c.skinDk); // jutting muzzle
    rect(q, 21, 17 + b, 2, 2, c.eye); dot(q, 21, 17 + b, 0xffffff);
    dot(q, 23, 19 + b, c.nose);
    return; // the near arm is drawn on top by buffDraw / as the overlay
  }

  // front: muscular chest + abs, off arm, mane, smug face (main arm rides on top)
  shaded(p, 15.5, 27 + b, 11.2, 8.4, c.skin, c.skinDk); // chest/torso
  disc(p, 11, 25 + b, 3.2, 2.6, c.skinHi); disc(p, 20, 25 + b, 3.2, 2.6, c.skinHi); // pecs
  line(p, 15.5, 25 + b, 15.5, 34 + b, c.skinDk);
  line(p, 11, 29 + b, 20, 29 + b, c.skinDk);
  line(p, 11, 32 + b, 20, 32 + b, c.skinDk);
  buffArmRig(p, facing, frame, "off");
  if (behind) buffArmRig(p, facing, frame, "main");
  // quill mane on the crown
  disc(p, 15.5, 13 + b, 5, 3.6, c.quill);
  quillSpikes(p, 15.5, 13.5 + b, 5, 3.4, c.quill);
  rect(p, 13, 11 + b, 5, 1, c.quillHi);
  // smug face below the mane
  shaded(p, 15.5, 18 + b, 4.8, 4, c.face, c.skinDk);
  rect(p, 13, 17 + b, 2, 2, c.eye); rect(p, 17, 17 + b, 2, 2, c.eye);
  dot(p, 13, 17 + b, 0xffffff); dot(p, 17, 17 + b, 0xffffff);
  dot(p, 15.5, 19 + b, c.nose);
  line(p, 13.6, 20.5 + b, 17.4, 20.5 + b, c.out);
}

/** The buff hog's in-front main arm, drawn over a held item. Empty when it tucks behind (up). */
export function buffMainArm(p: PixelSink, view: View, frame: FrameName, handDy = 0): void {
  const facing: Facing = view === "side" ? "right" : view;
  if (skeletonFor("hog", facing).behind) return;
  buffArmRig(p, facing, frame, "main", handDy);
}

export function buffDraw(p: PixelSink, view: View, frame: FrameName): void {
  buffBody(p, view, frame);
  buffMainArm(p, view, frame);
}
