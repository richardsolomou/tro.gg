/**
 * Trogg art: a hunched, big-shouldered cave ogre — heavy shoulders raised
 * around a skull head thrust low and forward, a deep brow shelf over sunken
 * glowing red eyes, a broad flat nose and a jagged underbite with corner tusks;
 * long thick arms dangling to heavy fists; short bent legs in a wide stance and
 * big three-toed feet; mottled stone-olive hide (refs: idle.png). Styles vary by
 * palette and brow: `moss`/`stone` are smooth-skulled, `ridge` is bonier.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, line, rect, shaded } from "../pixel_paint.ts";
import { bodyBob, footLift, isRun, RUN_LEAN, stride, FEET_Y, type View } from "./rig.ts";
import type { FrameName, PixelSink } from "../../shared/sprites.ts";

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
  moss: { out: 0x161a0f, base: 0x77834d, shade: 0x4d5731, light: 0x99a566, muzzle: 0x8a9258, eye: 0xff3b28, glow: 0xffd24a, pupil: 0x3a0a06, tooth: 0xeee6cf, ridge: false },
  stone: { out: 0x191b19, base: 0x787a70, shade: 0x4c4d47, light: 0x9a9b8f, muzzle: 0x8a8b80, eye: 0xff3328, glow: 0xffce46, pupil: 0x340806, tooth: 0xeeebde, ridge: false },
  ridge: { out: 0x141009, base: 0x6b6440, shade: 0x423c26, light: 0x8f8556, muzzle: 0x7e764a, eye: 0xff442c, glow: 0xffd04a, pupil: 0x300906, tooth: 0xe6dcbd, ridge: true },
};

/** A broad three-toed ogre foot with dark claw gaps. */
function troggFoot(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  shaded(p, x, y, 3.6, 2.3, c.base, c.shade);
  dot(p, x - 2, y + 1.5, c.out); dot(p, x, y + 1.5, c.out); dot(p, x + 2, y + 1.5, c.out);
}

/** A heavy clenched fist with knuckle creases. */
function troggFist(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  shaded(p, x, y, 3, 2.7, c.base, c.shade);
  dot(p, x - 1.6, y - 0.4, c.out); dot(p, x, y - 0.4, c.out); dot(p, x + 1.6, y - 0.4, c.out);
}

/** Mottled hide blotches so the hide reads as the reference's patchy stone ogre. */
function troggMottle(p: PixelSink, c: TroggSkin, b: number): void {
  const spots: [number, number, 0 | 1][] = [
    [9, 31, 0], [22, 33, 1], [12, 37, 1], [21, 29, 0], [7, 27, 1], [24, 27, 0], [14, 39, 1], [10, 24, 0],
  ];
  for (const [x, y, k] of spots) { const col = k ? c.shade : c.light; dot(p, x, y + b, col); dot(p, x + 1, y + b, col); }
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
  // deep-set glowing eyes tucked into shadowed sockets
  troggEye(p, 11, cy, c);
  troggEye(p, 18, cy, c);
  // heavy brow: a dark shelf bridging the sockets, no lit edge so it reads as
  // bone receding under the dome rather than a cap brim
  rect(p, 10, cy - 2, 13, 1, c.out);
  dot(p, 15, cy, c.shade); dot(p, 16, cy, c.shade); // brow furrow between the eyes
  // broad flat nose
  rect(p, 14, cy + 2, 4, 2, c.shade);
  dot(p, 14, cy + 3, c.out); dot(p, 17, cy + 3, c.out);
  // jagged underbite: dark mouth gap with corner tusks jutting up
  rect(p, 11, cy + 5, 10, 2, c.out);
  rect(p, 11, cy + 4, 1, 2, c.tooth); rect(p, 20, cy + 4, 1, 2, c.tooth); // corner tusks (underbite)
  dot(p, 14, cy + 5, c.tooth); dot(p, 17, cy + 5, c.tooth); // upper teeth biting down
}

export function troggDraw(p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void {
  const b = bodyBob(frame);
  const run = isRun(frame);
  const hb = b + (run ? 1 : 0);
  const lean = view === "side" && run ? RUN_LEAN : 0;
  const sw = stride(frame) * (run ? 3 : 2);

  if (view === "side") {
    // far leg + arm behind (darker), set back
    shaded(p, 13, 36 + b, 2.9, 4, c.shade, c.out);
    troggFoot(p, 13, FEET_Y + footLift(frame, false), c);
    shaded(p, 12, 29 + b, 2.7, 6, c.shade, c.out);
    troggFist(p, 12, 36 + b - sw, c);
    // upright trunk with a forward belly
    shaded(p, 16 + lean, 30 + b, 6, 7, c.base, c.shade);
    disc(p, 18 + lean, 31 + b, 3.4, 3.8, c.light);
    // hunched shoulder/upper back rising behind the neck
    shaded(p, 13 + lean * 0.5, 23 + b, 5.4, 5, c.base, c.shade);
    troggMottle(p, c, b);
    // head set high on the shoulders, leaning forward (right), jutting muzzle
    shaded(p, 20 + lean, 19 + hb, 5, 5, c.base, c.shade);
    disc(p, 24 + lean, 21 + hb, 2.5, 2.2, c.muzzle);
    if (c.ridge) dot(p, 17 + lean, 16 + hb, c.light);
    rect(p, 16 + lean, 17 + hb, 8, 1, c.out); // brow shelf
    troggEye(p, 20 + lean, 18 + hb, c);
    rect(p, 20 + lean, 23 + hb, 6, 2, c.out); // underbite mouth
    rect(p, 20 + lean, 22 + hb, 1, 2, c.tooth); rect(p, 24 + lean, 22 + hb, 1, 2, c.tooth);
    // near leg + arm in front
    shaded(p, 18, 36 + b, 3, 4, c.base, c.shade);
    troggFoot(p, 18.5, FEET_Y + footLift(frame, true), c);
    shaded(p, 19 + lean, 30 + b, 2.9, 6, c.base, c.shade);
    troggFist(p, 20 + lean, 36 + b + sw, c);
    return;
  }

  // short bent legs in a wide stance + big feet
  shaded(p, 11.5, 35 + b, 3.2, 4, c.base, c.shade);
  shaded(p, 20.5, 35 + b, 3.2, 4, c.base, c.shade);
  troggFoot(p, 11, FEET_Y + footLift(frame, true), c);
  troggFoot(p, 21, FEET_Y + footLift(frame, false), c);
  // long thick arms dangling outside the torso to heavy fists
  shaded(p, 6, 28 + b, 3.2, 7, c.base, c.shade);
  shaded(p, 26, 28 + b, 3.2, 7, c.base, c.shade);
  troggFist(p, 6, 35 + b + sw, c);
  troggFist(p, 26, 35 + b - sw, c);
  // torso with a lit chest/belly
  shaded(p, 16, 30 + b, 6.2, 7, c.base, c.shade);
  disc(p, 16, 31 + b, 4, 4.6, c.light);
  line(p, 16, 26 + b, 16, 36 + b, c.shade);
  // hulking shoulders raised high around the neck — the hunch
  shaded(p, 9, 22 + b, 5, 4.4, c.base, c.shade);
  shaded(p, 23, 22 + b, 5, 4.4, c.base, c.shade);
  // skull head sunk low and forward between the shoulders
  shaded(p, 16, 16 + hb, 6.2, 6.6, c.base, c.shade);
  troggMottle(p, c, b);

  if (view === "up") {
    // back of a hunched skull: lit crown, dark nape running down the spine
    disc(p, 16, 14 + hb, 5, 3.2, c.light);
    rect(p, 14, 22 + b, 4, 12, c.shade);
    return;
  }
  troggFaceFront(p, c, 16 + hb);
}
