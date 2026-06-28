/**
 * Generates the indexed avatar art in `shared/sprite_art.ts`.
 *
 * The committed `sprite_art.ts` is indexed pixel maps the runtime and tests
 * consume, but those maps are tedious to author by hand. This tool is the
 * source of truth for the art: it paints each 32x48 frame with readable pure
 * paint logic, quantises the result into a per-frame palette + key map, and
 * writes `sprite_art.ts`.
 *
 * Art direction is Pokémon Gold/Silver: a tight flat palette (a base colour,
 * one block shadow, one light), chunky flat shapes, and a clean dark outline
 * traced around the whole silhouette — pixelated, but unmistakably the creature.
 * Each frame is painted into its own layer with no outline; a single dilation
 * pass then draws the outline, so every sprite gets the same crisp border.
 *
 * Pipeline: `pnpm sprite-art` (this tool) → `shared/sprite_art.ts` → the
 * renderer in `sprites.ts` → `pnpm sprites` → the committed PNG/atlas. Edit the
 * draw code here, never the generated maps.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FRAME_H, FRAME_W, frames, rgbaSink, type Facing, type FrameName, type Kind, type PixelSink } from "../shared/sprites.ts";
import { compositeOver, disc, dot, fmtArt, line, outlinePass, PIXEL_KEYS, quantize, rect, shaded } from "./pixel_paint.ts";

// ── animation rig ──────────────────────────────────────────────────────────────

function isRun(frame: FrameName): boolean {
  return frame === "run_a" || frame === "run_b";
}

/** Which foot leads: +1 on `_a`, -1 on `_b`, 0 idle. Walk and run share the swing. */
function stride(frame: FrameName): number {
  if (frame === "walk_a" || frame === "run_a") return 1;
  if (frame === "walk_b" || frame === "run_b") return -1;
  return 0;
}

/** Vertical foot lift for a stride frame; feet alternate, higher on a run. */
function footLift(frame: FrameName, left: boolean): number {
  const lift = isRun(frame) ? -4 : -2;
  const s = stride(frame);
  if (s > 0) return left ? lift : 0;
  if (s < 0) return left ? 0 : lift;
  return 0;
}

/** Body bob as the avatar strides — 2px on a walk, 4px on a run's push-off. */
function bodyBob(frame: FrameName): number {
  if (frame === "idle") return 0;
  return isRun(frame) ? -4 : -2;
}

/** Forward hunch when running on the side profile (right-facing, pre-mirror). */
const RUN_LEAN = 4;

type View = "down" | "up" | "side";

/** Feet baseline (planted). */
const FEET_Y = 40;

/** Two feet with the walk lift applied; `y` is the planted baseline. */
function feet(p: PixelSink, frame: FrameName, base: number, shade: number, y: number, lx: number, rx: number): void {
  shaded(p, lx, y + footLift(frame, true), 2.6, 2.1, base, shade);
  shaded(p, rx, y + footLift(frame, false), 2.6, 2.1, base, shade);
}

/** A round GSC eye: a tall dark oval with a single light highlight pixel. */
function eye(p: PixelSink, x: number, y: number, dark: number, glint: number): void {
  rect(p, x, y, 2, 3, dark);
  dot(p, x, y, glint);
}

// ── trogg skins ──────────────────────────────────────────────────────────────
// A hunched, skull-faced cave brute: heavy stone hide, sunken glowing red eyes,
// a bared grimace of teeth, long arms (refs: idle.png / wave.png).

interface TroggSkin {
  out: number;
  base: number;
  shade: number;
  belly: number; // lighter chest
  bone: number; // pale skull face mask
  eye: number;
  pupil: number;
  tooth: number;
  /** Crown ornament: soft `ears`, stubby `horns`, or an earless craggy skull. */
  crest: "ears" | "horns" | "none";
}

const TROGG_SKINS: Record<string, TroggSkin> = {
  moss: { out: 0x161a0f, base: 0x77834d, shade: 0x4d5731, belly: 0x9aa468, bone: 0xbab487, eye: 0xff3b28, pupil: 0x3a0a06, tooth: 0xeee6cf, crest: "ears" },
  stone: { out: 0x1a1b19, base: 0x7d7f76, shade: 0x4f504a, belly: 0xa1a094, bone: 0xbdbaa9, eye: 0xff3328, pupil: 0x340806, tooth: 0xeeebde, crest: "none" },
  ridge: { out: 0x130f08, base: 0x675f3d, shade: 0x413b25, belly: 0x8a7a50, bone: 0xab9e6e, eye: 0xff442c, pupil: 0x300906, tooth: 0xe6dcbd, crest: "horns" },
};

// ── hog skins ──────────────────────────────────────────────────────────────
// A round cartoon hedgehog: a cream face and belly, two rounded ears, big shiny
// eyes, a small nose, and a spiky quill mantle (refs: surprised/blushing.png).

interface HogSkin {
  out: number;
  quill: number;
  quillDk: number;
  face: number;
  faceDk: number;
  nose: number;
  eye: number;
  glint: number;
  limb: number;
}

const HOG_SKINS: Record<string, HogSkin> = {
  classic: { out: 0x241a0e, quill: 0x7c5c37, quillDk: 0x503b22, face: 0xf0dcab, faceDk: 0xcdac72, nose: 0x3a2415, eye: 0x140d07, glint: 0xffffff, limb: 0x9c6f3f },
  snow: { out: 0x2b2a2e, quill: 0xb9bac1, quillDk: 0x83848d, face: 0xf3eee4, faceDk: 0xcfc4b2, nose: 0x564749, eye: 0x201a1a, glint: 0xffffff, limb: 0xada99f },
  ember: { out: 0x2a1810, quill: 0xb35a2c, quillDk: 0x7a3a18, face: 0xf0d6a4, faceDk: 0xcea06a, nose: 0x3a1c0e, eye: 0x1c100a, glint: 0xffffff, limb: 0xa9663a },
};

// ── trogg ──────────────────────────────────────────────────────────────────────

/** The crown ornament that distinguishes a trogg style (mirrored with the sprite). */
function troggCrest(p: PixelSink, c: TroggSkin, view: View, hb: number, lean: number): void {
  if (c.crest === "none") return;
  const horns = c.crest === "horns";
  if (view === "side") {
    if (horns) { disc(p, 10 + lean, 9 + hb, 1.6, 2, c.belly); dot(p, 11 + lean, 7 + hb, c.belly); }
    else disc(p, 8 + lean, 12 + hb, 2.2, 2.8, c.base);
    return;
  }
  const lx = horns ? 8 : 6;
  const rx = horns ? 23 : 25;
  if (horns) {
    disc(p, lx, 10 + hb, 1.6, 2.2, c.belly); disc(p, rx, 10 + hb, 1.6, 2.2, c.belly);
    dot(p, lx - 1, 8 + hb, c.belly); dot(p, rx + 1, 8 + hb, c.belly);
  } else {
    disc(p, lx, 12 + hb, 2.4, 3, c.base); disc(p, rx, 12 + hb, 2.4, 3, c.base);
  }
}

/** Skull-faced front: bone mask, brow shelf, sunken red eyes, bared grimace. */
function troggFaceFront(p: PixelSink, c: TroggSkin, hb: number): void {
  disc(p, 15.5, 17 + hb, 8.6, 6.2, c.bone);
  // heavy brow shelves
  rect(p, 8, 14 + hb, 7, 2, c.out);
  rect(p, 17, 14 + hb, 7, 2, c.out);
  // deep-set glowing eyes
  rect(p, 9, 16 + hb, 5, 4, c.eye);
  rect(p, 18, 16 + hb, 5, 4, c.eye);
  rect(p, 10, 17 + hb, 3, 2, c.pupil);
  rect(p, 19, 17 + hb, 3, 2, c.pupil);
  dot(p, 13, 16 + hb, 0xffd0c0); dot(p, 22, 16 + hb, 0xffd0c0);
  // flat nose shadow
  rect(p, 14, 21 + hb, 4, 2, c.shade);
  // wide grimacing maw with blocky teeth
  rect(p, 9, 25 + hb, 14, 4, c.out);
  for (let x = 10; x <= 21; x += 2) { rect(p, x, 25 + hb, 1, 2, c.tooth); dot(p, x + 1, 28 + hb, c.tooth); }
}

function troggDraw(p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void {
  const b = bodyBob(frame);
  const run = isRun(frame);
  const hb = b + (run ? 2 : 0);
  const lean = view === "side" && run ? RUN_LEAN : 0;
  feet(p, frame, c.shade, c.out, FEET_Y, run ? 11 : 12, run ? 21 : 20);

  if (view === "side") {
    const swing = stride(frame) * (run ? 4 : 2);
    // far arm behind, hunched body, head jutting forward
    shaded(p, 9, 30 + b, 3, 6, c.shade, c.out);
    shaded(p, 15 + lean * 0.3, 30 + b, 8.5, 9, c.base, c.shade);
    disc(p, 13, 32 + b, 4, 4, c.belly);
    shaded(p, 19 + lean, 17 + hb, 9, 7.6, c.base, c.shade);
    disc(p, 23, 18 + hb, 4, 4.4, c.bone);
    troggCrest(p, c, "side", hb, lean);
    // near arm swinging
    shaded(p, 19, 30 + b, 2.8, 5, c.base, c.shade);
    disc(p, 23, 36 + b + swing, 2.6, 2.2, c.base);
    // profile face
    rect(p, 20 + lean, 15 + hb, 7, 2, c.out);
    rect(p, 22 + lean, 17 + hb, 4, 3, c.eye); rect(p, 23 + lean, 18 + hb, 2, 1, c.pupil);
    rect(p, 21 + lean, 23 + hb, 6, 3, c.out);
    for (let x = 22; x <= 26; x += 2) dot(p, x + lean, 23 + hb, c.tooth);
    return;
  }

  // camera-facing: broad hunched shoulders, thick arms, narrower waist
  shaded(p, 5.5, 33 + b, 2.8, 5, c.base, c.shade);
  shaded(p, 25.5, 33 + b, 2.8, 5, c.base, c.shade);
  disc(p, 5.5, 38 + b + stride(frame) * 2, 2.6, 2.2, c.base);
  disc(p, 25.5, 38 + b - stride(frame) * 2, 2.6, 2.2, c.base);
  shaded(p, 15.5, 32 + b, 8.6, 8, c.base, c.shade);
  disc(p, 15.5, 34 + b, 5, 5, c.belly);
  // hulking shoulder yoke
  shaded(p, 9, 28 + b, 4.2, 3.6, c.base, c.shade);
  shaded(p, 22, 28 + b, 4.2, 3.6, c.base, c.shade);
  // head set low between the shoulders
  shaded(p, 15.5, 17 + hb, 9.6, 8.4, c.base, c.shade);
  troggCrest(p, c, view, hb, 0);

  if (view === "up") {
    // back of the skull: a pale cranial cap and dark nape, no face
    disc(p, 15.5, 14 + hb, 7.5, 4.4, c.belly);
    rect(p, 14, 22 + hb, 3, 8, c.shade);
    return;
  }
  troggFaceFront(p, c, hb);
}

// ── hog (classic / snow / ember) ──────────────────────────────────────────────

/** Spiky bumps around a dome's upper rim — outlined later, they read as quills. */
function quillSpikes(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number): void {
  const dirs: [number, number][] = [
    [-0.96, -0.28], [-0.78, -0.66], [-0.45, -0.92], [-0.05, -1.02], [0.38, -0.95], [0.72, -0.72], [0.94, -0.32],
    [-1.0, 0.15], [1.0, 0.15],
  ];
  for (const [nx, ny] of dirs) disc(p, cx + nx * rx, cy + ny * ry, 2.1, 2.1, colour);
}

function hogEar(p: PixelSink, x: number, y: number, h: HogSkin): void {
  disc(p, x, y, 2.4, 2.4, h.face);
  disc(p, x, y + 0.4, 1.2, 1.2, h.faceDk);
}

function hogArm(p: PixelSink, x: number, y: number, dir: -1 | 1, h: HogSkin): void {
  shaded(p, x + dir * 1.5, y + 2, 1.8, 2.6, h.face, h.faceDk);
}

/** A cute front face: shiny eyes, a soft muzzle, a small nose. */
function hogFaceFront(p: PixelSink, h: HogSkin, cy: number): void {
  eye(p, 10, cy - 1, h.eye, h.glint);
  eye(p, 20, cy - 1, h.eye, h.glint);
  // muzzle + nose
  disc(p, 15.5, cy + 3, 2.6, 2, h.faceDk);
  rect(p, 14, cy + 2, 3, 2, h.nose);
  dot(p, 15.5, cy + 4, h.out);
}

function hogDraw(p: PixelSink, view: View, frame: FrameName, h: HogSkin): void {
  const b = bodyBob(frame);
  feet(p, frame, h.limb, h.out, FEET_Y, 12, 19);

  if (view === "up") {
    quillSpikes(p, 15.5, 24 + b, 13, 13.5, h.quill);
    shaded(p, 15.5, 24 + b, 13, 13.5, h.quill, h.quillDk);
    hogEar(p, 9, 13 + b, h); hogEar(p, 22, 13 + b, h);
    disc(p, 15.5, 30 + b, 7, 5, h.quillDk);
    return;
  }

  if (view === "side") {
    quillSpikes(p, 11, 24 + b, 9.5, 12, h.quill);
    shaded(p, 11, 24 + b, 9.5, 12, h.quill, h.quillDk);
    shaded(p, 18, 31 + b, 8, 6.6, h.face, h.faceDk);
    hogEar(p, 20, 16 + b, h);
    shaded(p, 22, 22 + b, 6, 5.4, h.face, h.faceDk);
    disc(p, 27, 24 + b, 2.4, 2, h.faceDk);
    rect(p, 28, 23 + b, 2, 2, h.nose);
    eye(p, 22, 20 + b, h.eye, h.glint);
    hogArm(p, 18, 29 + b, 1, h);
    return;
  }

  // front: quill mantle, cream body and head, ears, face, little arms
  quillSpikes(p, 15.5, 22 + b, 13, 13.5, h.quill);
  shaded(p, 15.5, 22 + b, 13, 13.5, h.quill, h.quillDk);
  hogEar(p, 9, 11 + b, h); hogEar(p, 22, 11 + b, h);
  shaded(p, 15.5, 32 + b, 9.2, 7.2, h.face, h.faceDk);
  hogArm(p, 6, 30 + b, -1, h); hogArm(p, 24, 30 + b, 1, h);
  shaded(p, 15.5, 19 + b, 8, 6.6, h.face, h.faceDk);
  hogFaceFront(p, h, 18 + b);
}

// ── buff hog (big 2x2 showpiece) ──────────────────────────────────────────────
// A swole hedgehog mid double-biceps flex: tan muscle, ab lines, a quill mane,
// a tiny smug face (ref: 1.png).

const BUFF = {
  out: 0x241a0e,
  skin: 0xd2a96f,
  skinDk: 0x9c7438,
  face: 0xf0dcab,
  quill: 0x7c5c37,
  quillDk: 0x503b22,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

function buffDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = BUFF;
  const b = bodyBob(frame);
  feet(p, frame, c.skin, c.out, FEET_Y, 11, 20);
  shaded(p, 12, 35 + b, 3.4, 4.4, c.skin, c.skinDk);
  shaded(p, 19, 35 + b, 3.4, 4.4, c.skin, c.skinDk);

  if (view === "up") {
    disc(p, 15.5, 14 + b, 6, 4.6, c.quill);
    shaded(p, 15.5, 26 + b, 11, 9, c.skin, c.skinDk);
    rect(p, 14, 18 + b, 3, 12, c.skinDk);
    shaded(p, 4, 18 + b, 3.4, 6, c.skin, c.skinDk);
    shaded(p, 27, 18 + b, 3.4, 6, c.skin, c.skinDk);
    return;
  }

  const side = view === "side";
  shaded(p, 15.5, 27 + b, side ? 9.6 : 11.2, 8.4, c.skin, c.skinDk);
  // pecs + ab lines
  disc(p, 11, 25 + b, 3.2, 2.6, c.skin); disc(p, 20, 25 + b, 3.2, 2.6, c.skin);
  line(p, 15.5, 25 + b, 15.5, 34 + b, c.skinDk);
  line(p, 11, 29 + b, 20, 29 + b, c.skinDk);
  line(p, 11, 32 + b, 20, 32 + b, c.skinDk);
  // flexed arms framing the head: shoulder, peaked bicep, raised fist
  for (const s of [-1, 1] as const) {
    const sx = 15.5 + s * 8.5;
    shaded(p, sx, 23 + b, 3.6, 4, c.skin, c.skinDk);
    shaded(p, sx + s * 0.5, 17 + b, 3.4, 3.4, c.skin, c.skinDk);
    disc(p, sx + s * 1.5, 12 + b, 2.4, 2.4, c.skin);
  }
  // quill mane high on the crown
  disc(p, 15.5, 11 + b, 4.6, 3.4, c.quill);
  quillSpikes(p, 15.5, 11.5 + b, 4.6, 3.2, c.quill);
  // smug face, clear between the arms
  shaded(p, 15.5, 16.5 + b, 4.6, 3.8, c.face, c.skinDk);
  rect(p, 13, 15.5 + b, 2, 2, c.eye); rect(p, 17, 15.5 + b, 2, 2, c.eye);
  dot(p, 13, 15.5 + b, 0xffffff); dot(p, 17, 15.5 + b, 0xffffff);
  dot(p, 15.5, 17.5 + b, c.nose);
  line(p, 13.6, 19 + b, 17.4, 19 + b, c.out);
}

// ── dino hog (big 2x2 showpiece) ──────────────────────────────────────────────
// A hedgehog in a T-rex costume: green scaly body, a toothy open hood with the
// hog face inside, a spiky back ridge, a tail, little arms (ref: angry.png).

const DINO = {
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

function dinoDraw(p: PixelSink, view: View, frame: FrameName): void {
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
    return;
  }

  // front: scaly body, belly, ridge, little arms, toothy hood, hog face
  dinoRidge(p, 15.5, 9 + b, 8, c);
  shaded(p, 15.5, 29 + b, 11, 9, c.body, c.bodyDk);
  disc(p, 15.5, 31 + b, 6, 5.2, c.belly);
  shaded(p, 6, 27 + b, 2, 2.8, c.body, c.bodyDk);
  shaded(p, 25, 27 + b, 2, 2.8, c.body, c.bodyDk);
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

// ── chicken hog (easter egg) ──────────────────────────────────────────────────
// A hedgehog in a chicken costume: cream body, red comb, a beak, side wings, the
// hog face under it, orange feet, a russet tail (ref: costume.png).

const CHICK = {
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

function chickenDraw(p: PixelSink, view: View, frame: FrameName): void {
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

// ── ghost (cosmetic easter egg) ────────────────────────────────────────────────
// A hog draped in a pale sheet: two ear bumps poke up, two dark eye holes, a
// scalloped hem, two stubby feet (ref: ghost.png). One frame, never tinted.

const GHOST = {
  sheet: 0xf6f4ec,
  sheetDk: 0xd4d4cd,
  out: 0x1c1c1c,
  eye: 0x161616,
  foot: 0x9c6f3f,
  footDk: 0x6f4e2a,
  face: 0xf0dcab,
  faceDk: 0xcdac72,
} as const;

function ghostDrawArt(p: PixelSink): void {
  const g = GHOST;
  shaded(p, 12, FEET_Y, 2.1, 1.9, g.foot, g.footDk);
  shaded(p, 19, FEET_Y, 2.1, 1.9, g.foot, g.footDk);
  // a sliver of quill at the hem
  disc(p, 15.5, 36, 7, 2, g.faceDk);
  // ear bumps poking through
  disc(p, 9, 11, 2.6, 3, g.face); disc(p, 22, 11, 2.6, 3, g.face);
  disc(p, 9, 11.6, 1.3, 1.5, g.faceDk); disc(p, 22, 11.6, 1.3, 1.5, g.faceDk);
  // draped body + domed head
  shaded(p, 15.5, 26 + 0, 11.6, 11.4, g.sheet, g.sheetDk);
  disc(p, 15.5, 16, 9.4, 7.6, g.sheet);
  // face windows + eyes
  disc(p, 12, 20, 3, 4.2, g.face); disc(p, 19, 20, 3, 4.2, g.face);
  rect(p, 11, 18, 2, 3, g.eye); dot(p, 11, 18, 0xffffff);
  rect(p, 18, 18, 2, 3, g.eye); dot(p, 18, 18, 0xffffff);
  dot(p, 15.5, 23, g.faceDk);
  // side fold shadows
  disc(p, 7, 30, 2.4, 6, g.sheetDk); disc(p, 24, 30, 2.4, 6, g.sheetDk);
  // scalloped hem
  for (let x = 6; x <= 25; x += 4) { disc(p, x, 36, 1.9, 1.5, g.sheet); dot(p, x + 2, 38, g.sheetDk); }
}

// ── frame painting: layer, outline, composite ──────────────────────────────────

function outlineColour(kind: Kind, style: string): number {
  if (kind === "trogg") return (TROGG_SKINS[style] ?? TROGG_SKINS.moss!).out;
  if (style === "buff") return BUFF.out;
  if (style === "dino") return DINO.out;
  if (style === "chicken") return CHICK.out;
  return (HOG_SKINS[style] ?? HOG_SKINS.classic!).out;
}

function drawCharacter(p: PixelSink, kind: Kind, style: string, view: View, frame: FrameName): void {
  if (kind === "trogg") troggDraw(p, view, frame, TROGG_SKINS[style] ?? TROGG_SKINS.moss!);
  else if (style === "buff") buffDraw(p, view, frame);
  else if (style === "dino") dinoDraw(p, view, frame);
  else if (style === "chicken") chickenDraw(p, view, frame);
  else hogDraw(p, view, frame, HOG_SKINS[style] ?? HOG_SKINS.classic!);
}

function paintFrame(kind: Kind, style: string, facing: Facing, frame: FrameName): Uint8Array {
  // character on its own layer (outlined), composited over a soft ground shadow
  const layer = new Uint8Array(FRAME_W * FRAME_H * 4);
  const cs = rgbaSink(layer, FRAME_W, FRAME_H);
  const flip = facing === "left";
  const p: PixelSink = { set: (x, y, c) => cs.set(flip ? FRAME_W - 1 - x : x, y, c) };
  const view: View = facing === "left" || facing === "right" ? "side" : facing;
  drawCharacter(p, kind, style, view, frame);
  outlinePass(layer, outlineColour(kind, style), FRAME_W, FRAME_H);

  const data = new Uint8Array(FRAME_W * FRAME_H * 4);
  disc(rgbaSinkAlpha(data, 70), 15.5, 43, 11, 3.2, 0x000000);
  compositeOver(data, layer);
  return data;
}

/** A sink that paints at a fixed alpha — used only for the ground shadow. */
function rgbaSinkAlpha(data: Uint8Array, alpha: number): PixelSink {
  const base = rgbaSink(data, FRAME_W, FRAME_H);
  return { set: (x, y, c) => base.set(x, y, c, alpha) };
}

function paintGhost(): Uint8Array {
  const layer = new Uint8Array(FRAME_W * FRAME_H * 4);
  ghostDrawArt(rgbaSink(layer, FRAME_W, FRAME_H));
  outlinePass(layer, GHOST.out, FRAME_W, FRAME_H);
  const data = new Uint8Array(FRAME_W * FRAME_H * 4);
  disc(rgbaSinkAlpha(data, 70), 15.5, 43, 12, 3.4, 0x000000);
  compositeOver(data, layer);
  return data;
}

// ── emit ────────────────────────────────────────────────────────────────────────

const header = `/**
 * Indexed source art for the avatar sprite sheet.
 *
 * Each frame is a 32x48 text pixel map. \`.\` is transparent; any other
 * character indexes into that frame's local RGBA palette using PIXEL_KEYS.
 * The sprite renderer in \`sprites.ts\` blits these maps into the shared sheet
 * and the runtime canvas texture.
 *
 * GENERATED by \`tools/gen-sprite-art.ts\` (\`pnpm sprite-art\`). The paint logic
 * there is the source of truth — edit it and regenerate, don't hand-edit this file.
 */

export interface IndexedSpriteArt {
  palette: readonly number[];
  pixels: readonly string[];
}

export const PIXEL_KEYS = ${JSON.stringify(PIXEL_KEYS)};

`;

const entries = frames().map((f) => {
  const art = quantize(paintFrame(f.kind, f.style, f.facing, f.frame), FRAME_W, FRAME_H);
  return `  ${JSON.stringify(f.name)}: ${fmtArt(art, "  ")},`;
});

const ghost = fmtArt(quantize(paintGhost(), FRAME_W, FRAME_H), "");

const out =
  header +
  `export const AVATAR_FRAME_ART: Record<string, IndexedSpriteArt> = {\n${entries.join("\n")}\n};\n\n` +
  `export const GHOST_ART: IndexedSpriteArt = ${ghost};\n`;

const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "sprite_art.ts");
writeFileSync(OUT_PATH, out);
console.log(`Wrote ${entries.length} frames + ghost → ${OUT_PATH}`);
