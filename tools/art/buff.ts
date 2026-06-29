/**
 * Buff hog art: a swole hedgehog standing ready — tan muscle, pecs and ab lines,
 * a quill mane, a tiny smug face. Arms hang at its sides (fists on the hog rig's
 * hand joints) so it can wield, with a real side profile. A big 2×2 showpiece
 * authored at the shared frame size and rendered at double size.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, line, rect, shaded } from "../pixel_paint.ts";
import { bodyBob, drawArm, feet, FEET_Y, type View } from "./rig.ts";
import { quillSpikes } from "./hog.ts";
import { jointAt, skeletonFor, type JointName } from "../../shared/rig.ts";
import type { Facing, FrameName, PixelSink } from "../../shared/sprites.ts";

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

/** One swole arm from the shared rig: a deltoid cap at the shoulder, a muscular limb to the
 *  hand, and a fist — so it swings with the gait and a held item rides the fist. */
function buffArmRig(p: PixelSink, facing: Facing, frame: FrameName, slot: "main" | "off"): void {
  const c = BUFF;
  const sh = jointAt("hog", facing, frame, slot === "main" ? "mainShoulder" : "offShoulder");
  const hd = jointAt("hog", facing, frame, slot === "main" ? "mainHand" : "offHand");
  shaded(p, sh.x, sh.y - 1, 3, 3.4, c.skin, c.skinDk); // deltoid (shoulder cap)
  drawArm(p, sh.x, sh.y, hd.x, hd.y, 2.8, c.skin, c.skinDk);
  shaded(p, hd.x, hd.y, 2.6, 2.6, c.skin, c.skinDk); // fist
}

/** The buff hog minus its in-front main arm. The wrapper `buffDraw` adds the main arm on top;
 *  the generator paints body and arm apart for the near-arm-over-item overlay. */
export function buffBody(p: PixelSink, view: View, frame: FrameName): void {
  const c = BUFF;
  const facing: Facing = view === "side" ? "right" : view;
  const b = bodyBob(frame);
  const behind = skeletonFor("hog", facing).behind;
  feet(p, frame, c.skin, c.out, FEET_Y, 11, 20);
  shaded(p, 12, 35 + b, 3.4, 4.4, c.skin, c.skinDk);
  shaded(p, 19, 35 + b, 3.4, 4.4, c.skin, c.skinDk);

  if (view === "up") {
    // back: mane crown, broad muscular back with a spine groove, arms hanging at the sides
    disc(p, 15.5, 13 + b, 5.6, 4.2, c.quill);
    quillSpikes(p, 15.5, 13.5 + b, 5.6, 3.4, c.quill);
    shaded(p, 15.5, 27 + b, 11, 9, c.skin, c.skinDk);
    rect(p, 14, 18 + b, 3, 13, c.skinDk);
    buffArmRig(p, facing, frame, "off");
    buffArmRig(p, facing, frame, "main"); // behind the body when facing away
    return;
  }

  if (view === "side") {
    // right profile: muscular torso side-on, head leaning forward under the mane
    shaded(p, 14, 28 + b, 7.2, 8, c.skin, c.skinDk); // torso
    disc(p, 16, 27 + b, 3, 2.8, c.skin); // near pec
    line(p, 12, 31 + b, 18, 31 + b, c.skinDk); // ab hint
    disc(p, 16, 14 + b, 4.6, 3.6, c.quill);
    quillSpikes(p, 15, 14 + b, 4.8, 3.2, c.quill);
    shaded(p, 20, 18 + b, 3.6, 3.4, c.face, c.skinDk); // jutting muzzle
    rect(p, 21, 17 + b, 2, 2, c.eye); dot(p, 21, 17 + b, 0xffffff);
    dot(p, 23, 19 + b, c.nose);
    return; // the near arm is drawn on top by buffDraw / as the overlay
  }

  // front: muscular chest + abs, off arm, mane, smug face (main arm rides on top)
  shaded(p, 15.5, 27 + b, 11.2, 8.4, c.skin, c.skinDk); // chest/torso
  disc(p, 11, 25 + b, 3.2, 2.6, c.skin); disc(p, 20, 25 + b, 3.2, 2.6, c.skin); // pecs
  line(p, 15.5, 25 + b, 15.5, 34 + b, c.skinDk);
  line(p, 11, 29 + b, 20, 29 + b, c.skinDk);
  line(p, 11, 32 + b, 20, 32 + b, c.skinDk);
  buffArmRig(p, facing, frame, "off");
  if (behind) buffArmRig(p, facing, frame, "main");
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

/** The buff hog's in-front main arm, drawn over a held item. Empty when it tucks behind (up). */
export function buffMainArm(p: PixelSink, view: View, frame: FrameName): void {
  const facing: Facing = view === "side" ? "right" : view;
  if (skeletonFor("hog", facing).behind) return;
  buffArmRig(p, facing, frame, "main");
}

export function buffDraw(p: PixelSink, view: View, frame: FrameName): void {
  buffBody(p, view, frame);
  buffMainArm(p, view, frame);
}
