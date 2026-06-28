/**
 * Trogg art: a hunched, big-shouldered cave ogre — a skull head thrust forward
 * on the neck with a heavy brow, deep-set glowing red eyes, and a jagged
 * underbite; long thick arms dangling to heavy fists; bent legs and big
 * three-toed feet; mottled olive hide (refs: idle.png / wave.png). Styles vary
 * by palette and brow: `moss`/`stone` are smooth-skulled, `ridge` is bonier.
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
  pupil: number;
  tooth: number;
  /** A heavier bony brow/crown ridge marks `ridge`; the others are smooth-skulled. */
  ridge: boolean;
}

export const TROGG_SKINS: Record<string, TroggSkin> = {
  moss: { out: 0x161a0f, base: 0x77834d, shade: 0x4d5731, light: 0x99a566, muzzle: 0x8a9258, eye: 0xff3b28, pupil: 0x3a0a06, tooth: 0xeee6cf, ridge: false },
  stone: { out: 0x191b19, base: 0x787a70, shade: 0x4c4d47, light: 0x9a9b8f, muzzle: 0x8a8b80, eye: 0xff3328, pupil: 0x340806, tooth: 0xeeebde, ridge: false },
  ridge: { out: 0x141009, base: 0x6b6440, shade: 0x423c26, light: 0x8f8556, muzzle: 0x7e764a, eye: 0xff442c, pupil: 0x300906, tooth: 0xe6dcbd, ridge: true },
};

/** A broad three-toed ogre foot. */
function troggFoot(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  shaded(p, x, y, 3.2, 2.2, c.base, c.shade);
  dot(p, x - 1.6, y + 1.4, c.out); dot(p, x + 0.4, y + 1.4, c.out); dot(p, x + 2.2, y + 1.4, c.out);
}

/** A heavy clenched fist with knuckle creases. */
function troggFist(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  shaded(p, x, y, 2.9, 2.5, c.base, c.shade);
  dot(p, x - 1.6, y, c.out); dot(p, x, y, c.out); dot(p, x + 1.6, y, c.out);
}

/** Mottled hide blotches so the stone-skin reads as the reference's patchy ogre. */
function troggMottle(p: PixelSink, c: TroggSkin, b: number): void {
  const spots: [number, number, 0 | 1][] = [
    [9, 31, 0], [22, 33, 1], [12, 37, 1], [20, 30, 0], [7, 26, 1], [25, 27, 0], [15, 39, 1], [11, 24, 0],
  ];
  for (const [x, y, k] of spots) { const col = k ? c.shade : c.light; dot(p, x, y + b, col); dot(p, x + 1, y + b, col); }
}

/** Skull-faced front: heavy brow, deep-set red eyes, jutting muzzle, jagged underbite. */
function troggFaceFront(p: PixelSink, c: TroggSkin, cy: number): void {
  // jutting lighter muzzle behind the mouth
  disc(p, 15.5, cy + 4, 5.6, 3, c.muzzle);
  // brow: lit ridge above a dark shelf
  rect(p, 9, cy - 3, 14, 1, c.light);
  rect(p, 9, cy - 2, 14, 2, c.out);
  if (c.ridge) { rect(p, 12, cy - 5, 8, 1, c.out); rect(p, 13, cy - 4, 6, 1, c.light); }
  dot(p, 15.5, cy - 1, c.out);
  // sunken eye sockets + glowing red eyes
  rect(p, 9, cy, 6, 3, c.shade); rect(p, 17, cy, 6, 3, c.shade);
  rect(p, 10, cy, 4, 3, c.eye); rect(p, 18, cy, 4, 3, c.eye);
  rect(p, 11, cy + 1, 2, 1, c.pupil); rect(p, 19, cy + 1, 2, 1, c.pupil);
  dot(p, 13, cy, 0xffd0c0); dot(p, 21, cy, 0xffd0c0);
  // flat broad nose
  rect(p, 14, cy + 2, 4, 2, c.shade);
  dot(p, 14, cy + 3, c.out); dot(p, 17, cy + 3, c.out);
  // wide grimace: dark cavity, upper teeth down + lower teeth up (underbite), corner tusks
  rect(p, 10, cy + 5, 12, 3, c.out);
  for (let x = 11; x <= 20; x += 2) rect(p, x, cy + 5, 1, 2, c.tooth);
  for (let x = 12; x <= 19; x += 2) { dot(p, x, cy + 7, c.tooth); dot(p, x, cy + 8, c.tooth); }
  rect(p, 10, cy + 6, 1, 2, c.tooth); rect(p, 21, cy + 6, 1, 2, c.tooth);
}

export function troggDraw(p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void {
  const b = bodyBob(frame);
  const run = isRun(frame);
  const hb = b + (run ? 1 : 0);
  const lean = view === "side" && run ? RUN_LEAN : 0;
  const sw = stride(frame) * (run ? 3 : 2);

  if (view === "side") {
    // far leg + arm behind (darker)
    shaded(p, 13, 36 + b, 2.7, 4, c.shade, c.out);
    troggFoot(p, 13, FEET_Y + footLift(frame, false), c);
    shaded(p, 13, 27 + b, 2.7, 6, c.shade, c.out);
    troggFist(p, 13, 35 + b - sw, c);
    // hunched back arcing up over a sunken belly — the back is the silhouette's peak
    shaded(p, 14 + lean * 0.3, 27 + b, 7.6, 8.4, c.base, c.shade);
    disc(p, 16, 31 + b, 4.4, 3.8, c.light);
    troggMottle(p, c, b);
    // head thrust forward (right) and lower than the back, with a jutting muzzle
    shaded(p, 22 + lean, 25 + hb, 5.6, 5.2, c.base, c.shade);
    disc(p, 27 + lean, 27 + hb, 2.8, 2.4, c.muzzle);
    rect(p, 19 + lean, 22 + hb, 9, 2, c.out);
    if (c.ridge) rect(p, 19 + lean, 20 + hb, 6, 1, c.light);
    rect(p, 23 + lean, 24 + hb, 4, 3, c.eye); rect(p, 24 + lean, 25 + hb, 2, 1, c.pupil);
    dot(p, 26 + lean, 24 + hb, 0xffd0c0);
    rect(p, 22 + lean, 29 + hb, 7, 3, c.out);
    for (let x = 23; x <= 28; x += 2) { dot(p, x + lean, 29 + hb, c.tooth); dot(p, x + lean, 31 + hb, c.tooth); }
    // near leg + arm in front
    shaded(p, 18, 36 + b, 2.9, 4, c.base, c.shade);
    troggFoot(p, 18.5, FEET_Y + footLift(frame, true), c);
    shaded(p, 19, 27 + b, 2.9, 6.5, c.base, c.shade);
    troggFist(p, 20, 36 + b + sw, c);
    return;
  }

  // bent legs in a wide stance + big feet
  shaded(p, 11.5, 36 + b, 2.9, 4, c.base, c.shade);
  shaded(p, 19.5, 36 + b, 2.9, 4, c.base, c.shade);
  troggFoot(p, 11, FEET_Y + footLift(frame, true), c);
  troggFoot(p, 20.5, FEET_Y + footLift(frame, false), c);
  // long thick arms dangling outside the torso to heavy fists
  shaded(p, 5, 29 + b, 2.9, 6.5, c.base, c.shade);
  shaded(p, 26, 29 + b, 2.9, 6.5, c.base, c.shade);
  troggFist(p, 5, 36 + b + sw, c);
  troggFist(p, 26, 36 + b - sw, c);
  // torso — narrower than the shoulders so the arms read as separate
  shaded(p, 15.5, 31 + b, 6.4, 6.2, c.base, c.shade);
  disc(p, 15.5, 31 + b, 4.2, 4.2, c.light);
  line(p, 15.5, 27 + b, 15.5, 36 + b, c.shade);
  // hulking shoulders rising around the neck
  shaded(p, 8.5, 25 + b, 4.6, 4, c.base, c.shade);
  shaded(p, 22.5, 25 + b, 4.6, 4, c.base, c.shade);
  // distinct head sitting forward on the neck
  shaded(p, 15.5, 18 + hb, 6.8, 6.2, c.base, c.shade);
  troggMottle(p, c, b);

  if (view === "up") {
    // back of a hunched skull: lit crown, dark nape down the spine
    disc(p, 15.5, 16 + hb, 4.8, 3, c.light);
    rect(p, 14, 24 + b, 3, 10, c.shade);
    return;
  }
  troggFaceFront(p, c, 18 + hb);
}
