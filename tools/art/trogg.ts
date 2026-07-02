/**
 * Trogg art: a hunched, big-shouldered cave ogre — heavy shoulders raised
 * around a skull head thrust low and forward, a deep brow shelf over sunken
 * glowing red eyes, a broad flat nose and a jagged underbite with corner tusks;
 * long thick arms dangling to heavy fists; short bent legs in a wide stance and
 * big three-toed feet; GSC-style block highlights instead of noisy texture
 * (refs: trogg-reference.png, gsc-charmander-reference.jpg). Styles vary by
 * palette and brow: `moss`/`stone` are smooth-skulled, `ridge` is bonier.
 *
 * The body (torso/head/shoulders) is painted here; the arms and legs are placed
 * from the shared skeleton (`shared/rig.ts`) and drawn as limbs from each joint, so
 * gait and the attack reach are pose data, not bespoke per-frame maths — and a held
 * item rides the same hand joint the runtime reads.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, rect, shaded } from "../pixel_paint.ts";
import { drawArm, isRun, type View } from "./rig.ts";
import { bodyLean, jointAt, rootBob, skeletonFor, type JointName } from "../../shared/rig.ts";
import type { Facing, FrameName, PixelSink } from "../../shared/sprites.ts";

interface TroggSkin {
  out: number;
  base: number;
  shade: number;
  light: number; // lit highlights — chest, brow, cheekbones
  muzzle: number; // the slightly lighter jutting snout
  eye: number;
  glow: number; // hot center of the glowing eye
  pupil: number;
  tooth: number;
  /** A heavier bony brow/crown ridge marks `ridge`; the others are smooth-skulled. */
  ridge: boolean;
}

export const TROGG_SKINS: Record<string, TroggSkin> = {
  moss: { out: 0x101408, base: 0x6f8338, shade: 0x38481c, light: 0xb8bd73, muzzle: 0x9ba35a, eye: 0xf83820, glow: 0xffd048, pupil: 0x240804, tooth: 0xfff4d8, ridge: false },
  stone: { out: 0x121410, base: 0x74786c, shade: 0x3e4238, light: 0xc6c6a0, muzzle: 0x989a82, eye: 0xf83820, glow: 0xffd048, pupil: 0x240804, tooth: 0xf6eed6, ridge: false },
  ridge: { out: 0x100c06, base: 0x70673a, shade: 0x342c18, light: 0xc0b06a, muzzle: 0x95884c, eye: 0xf04828, glow: 0xffd050, pupil: 0x240804, tooth: 0xf0e0bc, ridge: true },
};

/** A broad three-toed ogre foot with dark claw gaps. */
function troggFoot(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  shaded(p, x, y, 3.6, 2.3, c.base, c.shade);
  dot(p, x - 2, y - 1, c.light);
  dot(p, x - 2, y + 1.5, c.out); dot(p, x, y + 1.5, c.out); dot(p, x + 2, y + 1.5, c.out);
}

/** A heavy clenched fist with knuckle creases. */
function troggFist(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  shaded(p, x, y, 3, 2.7, c.base, c.shade);
  rect(p, x - 2, y - 2, 2, 1, c.light);
  dot(p, x - 1.6, y - 0.4, c.out); dot(p, x, y - 0.4, c.out); dot(p, x + 1.6, y - 0.4, c.out);
}

/** Chunky GSC surface breaks: few larger patches, not noisy speckle. */
function troggGscMarks(p: PixelSink, c: TroggSkin, b: number, side = false): void {
  if (side) {
    rect(p, 15, 26 + b, 3, 1, c.light);
    rect(p, 11, 34 + b, 4, 1, c.shade);
    rect(p, 20, 32 + b, 2, 1, c.shade);
    dot(p, 22, 25 + b, c.light);
    return;
  }
  rect(p, 11, 24 + b, 3, 1, c.light);
  rect(p, 20, 25 + b, 3, 1, c.light);
  rect(p, 11, 36 + b, 3, 1, c.shade);
  rect(p, 19, 35 + b, 4, 1, c.shade);
  dot(p, 8, 29 + b, c.light);
}

/** One sunken, glowing red eye set deep under the brow shelf. */
function troggEye(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  rect(p, x - 1, y - 1, 5, 3, c.shade); // deep socket shadow
  rect(p, x, y, 3, 2, c.eye);
  dot(p, x + 1, y, c.glow); // hot glow center
  dot(p, x + 2, y + 1, c.pupil);
}

/** Skull-faced front: domed crown, heavy brow shelf, deep-set glowing eyes, flat
 *  nose, underbite tusks. `cy` is the head centre; the shaded dome above the brow
 *  is left to the head disc so the forehead reads as bone, not a cap. */
function troggFaceFront(p: PixelSink, c: TroggSkin, cy: number): void {
  // bony brow bumps over each eye (only on `ridge`)
  if (c.ridge) { dot(p, 11, cy - 3, c.light); dot(p, 20, cy - 3, c.light); }
  // lit crown: a bold two-row highlight across the top of the skull dome
  rect(p, 13, cy - 6, 5, 1, c.light);
  rect(p, 12, cy - 5, 8, 1, c.light);
  // deep-set glowing eyes tucked into shadowed sockets
  troggEye(p, 11, cy, c);
  troggEye(p, 18, cy, c);
  // heavy brow: a dark shelf bridging the sockets, no lit edge so it reads as
  // bone receding under the dome rather than a cap brim
  rect(p, 10, cy - 2, 13, 1, c.out);
  dot(p, 15, cy, c.shade); dot(p, 16, cy, c.shade); // brow furrow between the eyes
  // broad flat nose
  rect(p, 14, cy + 2, 4, 2, c.shade);
  dot(p, 13, cy + 1, c.muzzle);
  dot(p, 18, cy + 1, c.muzzle);
  dot(p, 14, cy + 3, c.out); dot(p, 17, cy + 3, c.out);
  // jagged underbite: dark mouth gap with corner tusks jutting up
  rect(p, 11, cy + 5, 10, 2, c.out);
  rect(p, 11, cy + 4, 1, 2, c.tooth); rect(p, 20, cy + 4, 1, 2, c.tooth); // corner tusks (underbite)
  dot(p, 14, cy + 5, c.tooth); dot(p, 17, cy + 5, c.tooth); // upper teeth biting down
}

/** A bent leg: a thick thigh at the hip, a shin run down to the foot (so a swinging foot
 *  stays attached through the stride's scissor), and a big foot at its planted/lifted end.
 *  `knee` kicks the shin's midpoint sideways — forward on the side profile. */
function troggLeg(p: PixelSink, hip: { x: number; y: number }, foot: { x: number; y: number }, c: TroggSkin, dark: boolean, knee = 0): void {
  const base = dark ? c.shade : c.base;
  const shade = dark ? c.out : c.shade;
  shaded(p, hip.x, hip.y, 3.2, 4, base, shade);
  drawArm(p, hip.x, hip.y + 2, foot.x, foot.y - 1, 2.4, base, shade, knee);
  if (!dark) dot(p, hip.x - 1, hip.y - 2, c.light);
  troggFoot(p, foot.x, foot.y, c);
}

/** The trogg minus its in-front main (near) arm: legs, off arm, torso, head, and — when the
 *  main arm tucks behind the body (facing up) — the main arm too. The wrapper `troggDraw` adds
 *  the in-front main arm on top; the generator paints body and arm separately so the near arm
 *  can ride over a held item (`troggMainArm`) while the silhouette keeps one unified outline. */
export function troggBody(p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void {
  const facing: Facing = view === "side" ? "right" : view;
  const b = rootBob(frame);
  const run = isRun(frame);
  const hb = b + (run ? 1 : 0);
  const lean = bodyLean("trogg", facing, frame); // run hunch + attack weight shift, shared with the rig's arms
  const behind = skeletonFor("trogg", facing).behind;
  const J = (j: JointName) => jointAt("trogg", facing, frame, j);

  if (view === "side") {
    // far (off) arm + far leg, set back and darker (the arm's joints already carry the lean)
    drawArm(p, J("offShoulder").x, J("offShoulder").y, J("offHand").x, J("offHand").y, 2.7, c.shade, c.out);
    troggFist(p, J("offHand").x, J("offHand").y, c);
    troggLeg(p, J("farHip"), J("farFoot"), c, true, -1.2);
    // upright trunk with a forward belly
    shaded(p, 16 + lean, 30 + b, 6, 7, c.base, c.shade);
    disc(p, 18 + lean, 31 + b, 3.1, 3.5, c.light);
    rect(p, 15 + lean, 27 + b, 4, 1, c.light);
    // hunched shoulder/upper back rising behind the neck, raised to fill under the head
    shaded(p, 13 + lean * 0.5, 21 + b, 5.4, 5.5, c.base, c.shade);
    troggGscMarks(p, c, b, true);
    // head set high on the shoulders (same crown height as the front), leaning forward, jutting muzzle
    shaded(p, 20 + lean, 16 + hb, 5, 5.5, c.base, c.shade);
    disc(p, 24 + lean, 18 + hb, 2.5, 2.2, c.muzzle);
    rect(p, 18 + lean, 12 + hb, 5, 1, c.light);
    if (c.ridge) dot(p, 17 + lean, 13 + hb, c.light);
    rect(p, 16 + lean, 14 + hb, 8, 1, c.out); // brow shelf
    troggEye(p, 20 + lean, 15 + hb, c);
    rect(p, 20 + lean, 20 + hb, 6, 2, c.out); // underbite mouth
    rect(p, 20 + lean, 19 + hb, 1, 2, c.tooth); rect(p, 24 + lean, 19 + hb, 1, 2, c.tooth);
    // near leg (the near arm rides on top in troggDraw / as the overlay)
    troggLeg(p, J("nearHip"), J("nearFoot"), c, false, -1.2);
    return;
  }

  // short bent legs in a wide stance + big feet
  troggLeg(p, J("nearHip"), J("nearFoot"), c, false);
  troggLeg(p, J("farHip"), J("farFoot"), c, false);
  // off arm hangs free outside the torso; the main arm too when it sits behind (facing up)
  drawArm(p, J("offShoulder").x, J("offShoulder").y, J("offHand").x, J("offHand").y, 3, c.base, c.shade);
  troggFist(p, J("offHand").x, J("offHand").y, c);
  if (behind) {
    drawArm(p, J("mainShoulder").x, J("mainShoulder").y, J("mainHand").x, J("mainHand").y, 3, c.base, c.shade);
    troggFist(p, J("mainHand").x, J("mainHand").y, c);
  }
  // torso — narrower than the shoulder span, so a clear notch sets the arms apart
  shaded(p, 16, 30 + b, 5.6, 7, c.base, c.shade);
  disc(p, 16, 31 + b, 3.6, 4.2, c.light);
  rect(p, 13, 27 + b, 6, 1, c.light);
  // belly plates: horizontal creases across the lit belly, GSC-style bold interior breaks
  rect(p, 13, 30 + b, 7, 1, c.shade);
  rect(p, 13, 33 + b, 7, 1, c.shade);
  // hulking shoulders raised high, capping the arms onto the neck — the hunch
  shaded(p, 9.5, 22 + b, 4.6, 4.2, c.base, c.shade);
  shaded(p, 22.5, 22 + b, 4.6, 4.2, c.base, c.shade);
  rect(p, 7, 20 + b, 3, 1, c.light); // lit shoulder caps
  rect(p, 22, 20 + b, 3, 1, c.light);
  // skull head sunk low and forward between the shoulders
  shaded(p, 16, 16 + hb, 6.2, 6.6, c.base, c.shade);
  troggGscMarks(p, c, b);

  if (view === "up") {
    // back of a hunched skull: lit crown, dark nape running down the spine
    disc(p, 16, 14 + hb, 4.8, 3, c.light);
    rect(p, 12, 24 + b, 3, 1, c.light);
    rect(p, 19, 28 + b, 4, 1, c.shade);
    rect(p, 14, 22 + b, 4, 12, c.shade);
  } else {
    troggFaceFront(p, c, 16 + hb);
  }
}

/** The in-front main (near) arm + fist, for the facings where it sits ahead of the body
 *  (down/left/right). Empty when the arm is behind (facing up). Drawn last by `troggDraw`,
 *  and emitted as the over-item overlay by the generator. */
export function troggMainArm(p: PixelSink, view: View, frame: FrameName, c: TroggSkin, handDy = 0): void {
  const facing: Facing = view === "side" ? "right" : view;
  if (skeletonFor("trogg", facing).behind) return;
  const J = (j: JointName) => jointAt("trogg", facing, frame, j); // joints carry the lean
  const thick = view === "side" ? 2.9 : 3;
  const hx = J("mainHand").x;
  const hy = J("mainHand").y + handDy;
  drawArm(p, J("mainShoulder").x, J("mainShoulder").y, hx, hy, thick, c.base, c.shade);
  troggFist(p, hx, hy, c);
}

export function troggDraw(p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void {
  troggBody(p, view, frame, c);
  troggMainArm(p, view, frame, c);
}
