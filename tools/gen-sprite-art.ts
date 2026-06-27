/**
 * Generates the indexed avatar art in `shared/sprite_art.ts`.
 *
 * The committed `sprite_art.ts` is indexed pixel maps the runtime and tests
 * consume, but those maps are tedious to author by hand. This tool is the
 * source of truth for the art: it paints each 32x48 frame with readable pure
 * paint logic (the same primitives the procedural terrain uses), quantises the
 * result into a per-frame palette + key map, and writes `sprite_art.ts`.
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

/** Indexing alphabet for the emitted maps. Kept in sync with `sprite_art.ts`. */
const PIXEL_KEYS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-/:;<=>?@[]^_{|}~";

// ── primitives ────────────────────────────────────────────────────────────────
// All coordinates are art pixels within a 32x48 frame. Colours are 0xRRGGBB;
// alpha is 0-255 and source-over blended by the sink.

function dot(p: PixelSink, x: number, y: number, colour: number, alpha?: number): void {
  p.set(Math.round(x), Math.round(y), colour, alpha);
}

function rect(p: PixelSink, x: number, y: number, w: number, h: number, colour: number, alpha?: number): void {
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) p.set(Math.round(x) + xx, Math.round(y) + yy, colour, alpha);
}

function line(p: PixelSink, x1: number, y1: number, x2: number, y2: number, colour: number, alpha?: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const steps = Math.max(dx, dy, 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    dot(p, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, colour, alpha);
  }
}

/** Filled ellipse centred at (cx, cy) with radii (rx, ry). Centres may be fractional. */
function disc(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number, alpha?: number): void {
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) p.set(x, y, colour, alpha);
    }
  }
}

/** Ellipse outline arc band — the 1px dark rim under `blob`. */
function blob(p: PixelSink, cx: number, cy: number, rx: number, ry: number, fill: number, out: number): void {
  disc(p, cx, cy, rx + 0.9, ry + 0.9, out);
  disc(p, cx, cy, rx, ry, fill);
}

/** A soft top-lit highlight cap on the upper half of a blob. */
function topLight(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number, alpha = 150): void {
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy); y++) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) dot(p, x, y, colour, alpha);
    }
  }
}

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

const SHADOW = 0x000000;

/** Feet baseline (planted) and the contact-shadow centre. */
const FEET_Y = 40;

function groundShadow(p: PixelSink, rx: number, ry: number): void {
  disc(p, 15.5, 43, rx, ry, SHADOW, 70);
}

/** Two feet with the walk lift applied; `y` is the planted baseline. */
function feet(p: PixelSink, frame: FrameName, colour: number, out: number, y: number, lx: number, rx: number): void {
  blob(p, lx, y + footLift(frame, true), 2.6, 2.1, colour, out);
  blob(p, rx, y + footLift(frame, false), 2.6, 2.1, colour, out);
}

// ── trogg skins ──────────────────────────────────────────────────────────────
// A hunched, skull-faced cave brute: heavy stone hide, sunken glowing red eyes,
// a bared grimace of teeth, and long dangling arms (refs: idle.png / wave.png).

interface TroggSkin {
  out: number;
  body: number;
  light: number;
  shade: number;
  belly: number;
  bone: number; // pale skull face mask
  eye: number;
  pupil: number;
  mouth: number;
  tooth: number;
  /** Crown ornament: soft `ears`, stubby `horns`, or an earless craggy skull. */
  crest: "ears" | "horns" | "none";
}

const TROGG_SKINS: Record<string, TroggSkin> = {
  // Moss-stained hide, warm bone face, soft ear nubs — the default cave-dweller (wave.png).
  moss: { out: 0x20231a, body: 0x6f7a4e, light: 0x9aa56c, shade: 0x474f2f, belly: 0x848d5c, bone: 0xb7b187, eye: 0xff3b28, pupil: 0x3a0a06, mouth: 0x120d08, tooth: 0xece3c8, crest: "ears" },
  // Cold grey stone brute, craggy earless skull (idle.png).
  stone: { out: 0x1d1f1d, body: 0x767871, light: 0xa6a692, shade: 0x474843, belly: 0x8a897d, bone: 0xb9b6a6, eye: 0xff3328, pupil: 0x340806, mouth: 0x121212, tooth: 0xeeebde, crest: "none" },
  // Dark olive ridge-back with a heavier brow and small horn nubs.
  ridge: { out: 0x171309, body: 0x60593a, light: 0x9c8a55, shade: 0x3a3522, belly: 0x7c6e48, bone: 0xa99c6c, eye: 0xff442c, pupil: 0x300906, mouth: 0x140f08, tooth: 0xe6dcbd, crest: "horns" },
};

// ── hog skins ──────────────────────────────────────────────────────────────
// A round cartoon hedgehog: a cream face and belly, two rounded ears, big shiny
// eyes, a small nose, and a dashed quill mantle (refs: surprised.png/blushing.png).

interface HogSkin {
  out: number;
  quill: number;
  quillLt: number;
  quillDk: number;
  face: number;
  faceLt: number;
  faceDk: number;
  nose: number;
  eye: number;
  glint: number;
  limb: number; // little arms/feet
}

const HOG_SKINS: Record<string, HogSkin> = {
  // Warm brown quills, cream face — the classic hedgehog.
  classic: { out: 0x2a1d10, quill: 0x6e5334, quillLt: 0x8c6a41, quillDk: 0x3f2f1b, face: 0xe9d1a2, faceLt: 0xf5e8c8, faceDk: 0xcaa86c, nose: 0x3a2415, eye: 0x140d07, glint: 0xffffff, limb: 0x9c6f3f },
  // Pale ash-grey quills, frost-cream face — the snowy hog.
  snow: { out: 0x2b2a2d, quill: 0x9fa0a8, quillLt: 0xc6c7cd, quillDk: 0x70707a, face: 0xeee7dc, faceLt: 0xf8f3ec, faceDk: 0xccc0ac, nose: 0x47383a, eye: 0x201a1a, glint: 0xffffff, limb: 0xada99f },
  // Rust-red quills, toasted face — the ember hog.
  ember: { out: 0x2c160c, quill: 0xa4502a, quillLt: 0xcb6c38, quillDk: 0x612c16, face: 0xead0a0, faceLt: 0xf6e2bb, faceDk: 0xcd9d64, nose: 0x3a1c0e, eye: 0x1c100a, glint: 0xffffff, limb: 0xa9663a },
};

// ── trogg ──────────────────────────────────────────────────────────────────────

/** The crown ornament that distinguishes a trogg style (mirrored with the sprite). */
function troggCrest(p: PixelSink, c: TroggSkin, view: View, hb: number, lean: number): void {
  if (c.crest === "none") {
    if (view !== "side") {
      // a couple of stone lumps so the bald skull reads as rock
      dot(p, 7, 9 + hb, c.light); dot(p, 24, 9 + hb, c.light);
      dot(p, 8, 8 + hb, c.shade); dot(p, 23, 8 + hb, c.shade);
    }
    return;
  }
  const horns = c.crest === "horns";
  if (view === "side") {
    if (horns) { blob(p, 9 + lean, 9 + hb, 1.8, 2.2, c.light, c.out); dot(p, 11 + lean, 7 + hb, c.out); }
    else blob(p, 7 + lean, 13 + hb, 2.4, 3, c.body, c.out);
    return;
  }
  const lx = horns ? 8 : 6;
  const rx = horns ? 23 : 25;
  if (horns) {
    // short curved horn nubs angling outward
    blob(p, lx, 10 + hb, 1.8, 2.2, c.light, c.out);
    blob(p, rx, 10 + hb, 1.8, 2.2, c.light, c.out);
    dot(p, lx - 1, 8 + hb, c.out); dot(p, rx + 1, 8 + hb, c.out);
  } else {
    // soft rounded ear nubs at the head sides
    blob(p, lx, 12 + hb, 2.4, 3, c.body, c.out);
    blob(p, rx, 12 + hb, 2.4, 3, c.body, c.out);
  }
}

/** Rocky flecks across the hide so it reads as mottled stone. */
function troggTexture(p: PixelSink, c: TroggSkin): void {
  const flecks: [number, number][] = [
    [9, 26], [16, 24], [23, 27], [11, 33], [21, 32], [7, 37], [16, 38], [24, 36],
    [13, 30], [19, 29], [10, 22], [22, 22],
  ];
  for (const [x, y] of flecks) dot(p, x, y, (x + y) % 2 === 0 ? c.light : c.shade, 130);
}

function troggHand(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  blob(p, x, y, 2.6, 2.2, c.light, c.out);
  dot(p, x - 2, y + 2, c.out); dot(p, x, y + 2, c.out); dot(p, x + 2, y + 2, c.out);
  dot(p, x - 1, y + 2, c.shade); dot(p, x + 1, y + 2, c.shade);
}

/** Skull-faced front: bone mask, brow shelf, sunken red eyes, bared grimace. */
function troggFaceFront(p: PixelSink, c: TroggSkin, hb: number): void {
  // bone-pale upper face mask
  disc(p, 15.5, 17 + hb, 9.2, 6.6, c.bone);
  topLight(p, 15.5, 14 + hb, 8.5, 4.5, 0xffffff, 40);
  // heavy brow shelves
  rect(p, 7, 14 + hb, 8, 2, c.out);
  rect(p, 17, 14 + hb, 8, 2, c.out);
  dot(p, 15.5, 14 + hb, c.shade);
  // deep-set glowing eyes
  rect(p, 9, 16 + hb, 5, 4, c.eye);
  rect(p, 18, 16 + hb, 5, 4, c.eye);
  rect(p, 10, 17 + hb, 3, 2, c.pupil);
  rect(p, 19, 17 + hb, 3, 2, c.pupil);
  dot(p, 13, 16 + hb, 0xffd0c0, 180); dot(p, 22, 16 + hb, 0xffd0c0, 180);
  // broad flat nose with nostrils
  rect(p, 14, 21 + hb, 4, 2, c.shade);
  dot(p, 14, 22 + hb, c.out); dot(p, 17, 22 + hb, c.out);
  // wide grimacing maw with teeth
  rect(p, 9, 25 + hb, 14, 4, c.mouth);
  rect(p, 9, 25 + hb, 14, 1, c.out);
  for (let x = 10; x <= 22; x += 2) {
    dot(p, x, 25 + hb, c.tooth); dot(p, x, 26 + hb, c.tooth);
    dot(p, x + 1, 28 + hb, c.tooth);
  }
  // cheek shade
  dot(p, 8, 22 + hb, c.shade); dot(p, 23, 22 + hb, c.shade);
}

function troggDraw(p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void {
  const b = bodyBob(frame);
  const run = isRun(frame);
  const hb = b + (run ? 2 : 0);
  const lean = view === "side" && run ? RUN_LEAN : 0;
  groundShadow(p, run ? 12 : 11, 3.4);
  feet(p, frame, c.shade, c.out, FEET_Y, run ? 10 : 11, run ? 21 : 20);

  if (view === "side") {
    const swing = stride(frame) * (run ? 4 : 2);
    // hunched back, sunken belly, long arms — the reference crouch
    blob(p, 15 + lean * 0.3, 30 + b, 9, 9.5, c.body, c.out);
    disc(p, 12, 31 + b, 4.6, 4.4, c.belly);
    line(p, 9, 26 + b, 19, 26 + b, c.shade);
    line(p, 10, 30 + b, 19, 30 + b, c.shade);
    // head
    blob(p, 18 + lean, 17 + hb, 10, 8, c.body, c.out);
    troggCrest(p, c, "side", hb, lean);
    // back arm (behind), front arm (swinging)
    blob(p, 8, 25 + b, 3.2, 6.4, c.shade, c.out);
    line(p, 7, 28 + b, 6, 36 + b + swing, c.shade);
    troggHand(p, 6, 36 + b + swing, c);
    line(p, 19, 28 + b, 24, 32 + b + swing * 2, c.shade);
    troggHand(p, 24, 33 + b + swing * 2, c);
    // profile skull face
    disc(p, 22, 17 + hb, 4.4, 4.8, c.bone);
    rect(p, 19 + lean, 15 + hb, 7, 2, c.out);
    rect(p, 22 + lean, 17 + hb, 4, 3, c.eye);
    rect(p, 23 + lean, 18 + hb, 2, 1, c.pupil);
    rect(p, 21 + lean, 23 + hb, 6, 3, c.mouth);
    for (let x = 22; x <= 26; x += 2) dot(p, x + lean, 23 + hb, c.tooth);
    dot(p, 26 + lean, 20 + hb, c.shade);
    troggTexture(p, c);
    return;
  }

  // camera-facing: broad hunched shoulders, thick dangling arms, narrower waist
  blob(p, 15.5, 32 + b, 8.6, 8, c.body, c.out);
  disc(p, 15.5, 34 + b, 5, 5.2, c.belly);
  // hulking shoulder yoke wider than the head
  blob(p, 9, 27 + b, 4.4, 4, c.body, c.out);
  blob(p, 22, 27 + b, 4.4, 4, c.body, c.out);
  disc(p, 9, 26 + b, 2.6, 2, c.light, 120);
  disc(p, 22, 26 + b, 2.6, 2, c.light, 120);
  // thick arms hanging to heavy hands
  const la = 37 + b + stride(frame) * 2;
  const ra = 37 + b - stride(frame) * 2;
  blob(p, 5, 32 + b, 2.4, 4.6, c.body, c.out);
  blob(p, 26, 32 + b, 2.4, 4.6, c.body, c.out);
  troggHand(p, 5, la, c);
  troggHand(p, 26, ra, c);
  line(p, 11, 29 + b, 20, 29 + b, c.shade);

  // head set low between the shoulders
  blob(p, 15.5, 17 + hb, 10, 8.6, c.body, c.out);
  troggCrest(p, c, view, hb, 0);

  if (view === "up") {
    // back of the skull: cranial highlight and nape, no face
    topLight(p, 15.5, 14 + hb, 9.5, 5, c.light, 120);
    rect(p, 14, 22 + hb, 3, 8, c.shade);
    troggTexture(p, c);
    return;
  }

  troggFaceFront(p, c, hb);
  troggTexture(p, c);
}

// ── hog (classic / snow / ember) ──────────────────────────────────────────────

/** Quill mantle: a soft colour cloak stippled with short dash marks. */
function quillDome(p: PixelSink, cx: number, cy: number, rx: number, ry: number, h: HogSkin): void {
  blob(p, cx, cy, rx, ry, h.quill, h.out);
  topLight(p, cx, cy - ry * 0.2, rx * 0.9, ry * 0.8, h.quillLt, 90);
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      const k = (x * 5 + y * 3) % 6;
      if (k === 0) line(p, x - 0.6, y, x + 0.6, y, h.quillDk);
      else if (k === 3) dot(p, x, y, h.quillLt, 120);
    }
  }
}

function hogEar(p: PixelSink, x: number, y: number, h: HogSkin): void {
  blob(p, x, y, 2.4, 2.4, h.face, h.out);
  disc(p, x, y + 0.3, 1.3, 1.3, h.faceDk);
}

function hogArm(p: PixelSink, x: number, y: number, dir: -1 | 1, h: HogSkin): void {
  line(p, x, y, x + dir * 3, y + 4, h.faceDk);
  line(p, x + 1, y, x + 1 + dir * 3, y + 4, h.faceDk);
  blob(p, x + dir * 3.2, y + 4.4, 1.5, 1.6, h.faceDk, h.out);
}

/** A cute front face: shiny eyes, a heart-shaped muzzle bridge, small nose. */
function hogFaceFront(p: PixelSink, h: HogSkin, cy: number): void {
  // shiny round eyes
  for (const ex of [11, 20]) {
    blob(p, ex, cy, 1.8, 2.2, h.eye, h.out);
    dot(p, ex - 0.6, cy - 1.2, h.glint); dot(p, ex - 0.6, cy - 0.4, h.glint);
  }
  // muzzle bridge — the soft hedgehog "heart" snout
  line(p, 12.5, cy + 3, 15.5, cy + 1.6, h.out);
  line(p, 18.5, cy + 3, 15.5, cy + 1.6, h.out);
  blob(p, 15.5, cy + 3, 2.2, 1.6, h.faceLt, h.out);
  dot(p, 15.5, cy + 2.4, h.nose); dot(p, 15, cy + 2.4, h.nose); dot(p, 16, cy + 2.4, h.nose);
  // mouth
  dot(p, 14, cy + 4.4, h.out); dot(p, 17, cy + 4.4, h.out);
}

function hogDraw(p: PixelSink, view: View, frame: FrameName, h: HogSkin): void {
  const b = bodyBob(frame);
  groundShadow(p, 11, 3.2);
  feet(p, frame, h.limb, h.out, FEET_Y, 12, 19);

  if (view === "up") {
    // back: a near-full quill dome with two ear backs
    quillDome(p, 15.5, 24 + b, 13, 14, h);
    hogEar(p, 9, 13 + b, h); hogEar(p, 22, 13 + b, h);
    disc(p, 15.5, 33 + b, 7, 5, h.quillDk, 90);
    return;
  }

  if (view === "side") {
    // quill cloak sweeping behind, the face/muzzle pointing forward
    quillDome(p, 11, 24 + b, 9, 12, h);
    blob(p, 18, 31 + b, 8.4, 7, h.face, h.out);
    disc(p, 18, 33 + b, 5.4, 4.6, h.faceLt);
    hogEar(p, 20, 16 + b, h);
    blob(p, 21, 22 + b, 6, 5.6, h.face, h.out);
    blob(p, 26, 24 + b, 3.2, 2.6, h.faceLt, h.out);
    dot(p, 28.5, 24 + b, h.nose); dot(p, 28.5, 25 + b, h.nose);
    blob(p, 23, 21 + b, 1.7, 2.1, h.eye, h.out);
    dot(p, 22.4, 20 + b, h.glint);
    hogArm(p, 19, 28 + b, 1, h);
    return;
  }

  // front: quill mantle, cream body and head, ears, face, little arms
  quillDome(p, 15.5, 22 + b, 13, 14, h);
  hogEar(p, 9, 11 + b, h); hogEar(p, 22, 11 + b, h);
  blob(p, 15.5, 32 + b, 9.4, 7.4, h.face, h.out);
  disc(p, 15.5, 33 + b, 6.4, 5, h.faceLt);
  hogArm(p, 7, 30 + b, -1, h); hogArm(p, 24, 30 + b, 1, h);
  blob(p, 15.5, 19 + b, 8, 6.6, h.face, h.out);
  disc(p, 15.5, 20 + b, 6, 4.4, h.faceLt);
  hogFaceFront(p, h, 18 + b);
}

// ── buff hog (big 2x2 showpiece) ──────────────────────────────────────────────
// A swole hedgehog mid double-biceps flex: tan muscle, ab lines, a quill mane,
// a tiny smug face (ref: 1.png).

const BUFF = {
  out: 0x2a1d10,
  skin: 0xcaa06a,
  skinLt: 0xe6c389,
  skinDk: 0x9a6f38,
  face: 0xf2e4c2,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

function buffDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = BUFF;
  const b = bodyBob(frame);
  groundShadow(p, 12.5, 3.6);
  feet(p, frame, c.skinDk, c.out, FEET_Y, 11, 20);
  // stocky legs
  blob(p, 12, 35 + b, 3.4, 4.4, c.skin, c.out);
  blob(p, 19, 35 + b, 3.4, 4.4, c.skin, c.out);

  if (view === "up") {
    quillDome(p, 15.5, 14 + b, 6.4, 5, HOG_SKINS.classic!);
    blob(p, 15.5, 26 + b, 11, 9, c.skin, c.out);
    rect(p, 14, 18 + b, 3, 12, c.skinDk); // spine
    blob(p, 4, 18 + b, 3.6, 6, c.skin, c.out);
    blob(p, 27, 18 + b, 3.6, 6, c.skin, c.out);
    return;
  }

  const side = view === "side";
  // broad chest + torso
  blob(p, 15.5, 27 + b, side ? 9.6 : 11.2, 8.4, c.skin, c.out);
  disc(p, 11, 25 + b, 3.4, 3, c.skinLt);
  disc(p, 20, 25 + b, 3.4, 3, c.skinLt);
  // ab lines
  line(p, 15.5, 25 + b, 15.5, 34 + b, c.out);
  line(p, 11, 29 + b, 20, 29 + b, c.skinDk);
  line(p, 11, 32 + b, 20, 32 + b, c.skinDk);
  // flexed arms framing the head: shoulder, peaked bicep, fist at the top corner
  for (const s of [-1, 1] as const) {
    const sx = 15.5 + s * 8.5;
    blob(p, sx, 23 + b, 3.6, 4, c.skinDk, c.out); // shoulder
    blob(p, sx + s * 0.5, 17 + b, 3.4, 3.4, c.skin, c.out); // bicep peak
    disc(p, sx + s * 0.5, 16 + b, 2.4, 1.8, c.skinLt, 150);
    blob(p, sx + s * 1.5, 12 + b, 2.4, 2.4, c.skin, c.out); // raised fist
    dot(p, sx + s * 1.5, 11 + b, c.skinDk);
  }
  // quill mane high on the crown
  quillDome(p, 15.5, 11 + b, 4.4, 3.4, HOG_SKINS.classic!);
  // smug face, clear in the centre between the arms
  blob(p, 15.5, 16.5 + b, 4.6, 3.8, c.face, c.out);
  blob(p, 13.4, 16 + b, 1, 1.2, c.eye, c.eye);
  blob(p, 17.6, 16 + b, 1, 1.2, c.eye, c.eye);
  dot(p, 12.8, 15 + b, 0xffffff); dot(p, 17, 15 + b, 0xffffff);
  dot(p, 15.5, 17.6 + b, c.nose);
  line(p, 13.6, 19 + b, 17.4, 19 + b, c.out);
}

// ── dino hog (big 2x2 showpiece) ──────────────────────────────────────────────
// A hedgehog in a T-rex costume: green scaly body, a toothy open hood with the
// hog face inside, a spiky back ridge, a tail, little arms (ref: angry.png).

const DINO = {
  out: 0x17250f,
  body: 0x74883a,
  bodyLt: 0x9fb14b,
  bodyDk: 0x47591f,
  belly: 0xc6c277,
  tooth: 0xf3eedf,
  face: 0xe9d1a2,
  faceDk: 0xcaa86c,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

/** Sawtooth ridge of plates along the costume's back. */
function dinoRidge(p: PixelSink, cx: number, top: number, span: number, c: typeof DINO): void {
  for (let x = cx - span; x <= cx + span; x += 3) {
    dot(p, x, top, c.bodyDk); dot(p, x, top - 1, c.bodyDk); dot(p, x, top - 2, c.out);
  }
}

/** Scattered scale stipple — the costume's pebbled hide. */
function dinoScales(p: PixelSink, c: typeof DINO, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y += 3) {
    for (let x = x0 + (y % 6 === 0 ? 0 : 2); x <= x1; x += 4) {
      dot(p, x, y, c.bodyDk, 170);
      dot(p, x, y - 1, c.bodyLt, 130);
    }
  }
}

function dinoDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = DINO;
  const b = bodyBob(frame);
  groundShadow(p, 13, 3.6);
  feet(p, frame, c.bodyDk, c.out, FEET_Y, 11, 20);
  // sturdy hind legs
  blob(p, 12, 35 + b, 3.6, 4.6, c.body, c.out);
  blob(p, 19, 35 + b, 3.6, 4.6, c.body, c.out);

  if (view === "up") {
    blob(p, 15.5, 27 + b, 11, 9.4, c.body, c.out);
    rect(p, 14, 18 + b, 3, 12, c.bodyDk);
    dinoRidge(p, 15.5, 18 + b, 8, c);
    dinoScales(p, c, 7, 22 + b, 24, 34 + b);
    blob(p, 4, 32 + b, 4, 2.6, c.bodyDk, c.out); // tail base
    return;
  }

  if (view === "side") {
    // long tail sweeping back, body, toothy head forward
    blob(p, 4, 31 + b, 5.4, 3, c.body, c.out);
    dot(p, 0.5, 30 + b, c.out);
    blob(p, 15, 27 + b, 9, 8, c.body, c.out);
    disc(p, 16, 29 + b, 5, 4.4, c.belly);
    dinoScales(p, c, 8, 22 + b, 21, 32 + b);
    dinoRidge(p, 14, 20 + b, 5, c);
    // head + open jaw
    blob(p, 23, 21 + b, 6.4, 5.4, c.body, c.out);
    rect(p, 18, 23 + b, 12, 1, c.out);
    for (let x = 18; x <= 28; x += 2) { dot(p, x, 21 + b, c.tooth); dot(p, x + 1, 25 + b, c.tooth); }
    // hog face inside the maw
    disc(p, 23, 24 + b, 2.6, 2.2, c.face);
    dot(p, 24, 23.5 + b, c.eye);
    dot(p, 25.5, 16.5 + b, c.eye);
    return;
  }

  // front: belly, scaled body, ridge, little arms, toothy hood, hog face
  blob(p, 15.5, 29 + b, 11, 9, c.body, c.out);
  disc(p, 15.5, 30 + b, 6, 5.2, c.belly);
  dinoScales(p, c, 7, 24 + b, 24, 35 + b);
  blob(p, 6, 27 + b, 2, 2.8, c.bodyDk, c.out);
  blob(p, 25, 27 + b, 2, 2.8, c.bodyDk, c.out);
  // toothy hood framing the face
  blob(p, 15.5, 16 + b, 9, 6.8, c.body, c.out);
  dinoRidge(p, 15.5, 10 + b, 8, c);
  dot(p, 11, 13 + b, c.eye); dot(p, 20, 13 + b, c.eye);
  rect(p, 7, 19 + b, 17, 1, c.out);
  for (let x = 8; x <= 22; x += 2) dot(p, x, 18 + b, c.tooth);
  // hog face peeking out
  disc(p, 15.5, 21 + b, 4.4, 3.4, c.face);
  blob(p, 13.4, 20.6 + b, 0.9, 1.1, c.eye, c.eye);
  blob(p, 17.6, 20.6 + b, 0.9, 1.1, c.eye, c.eye);
  dot(p, 15.5, 22 + b, c.nose);
  line(p, 13.5, 23.5 + b, 17.5, 23.5 + b, c.out);
}

// ── chicken hog (easter egg) ──────────────────────────────────────────────────
// A hedgehog in a chicken costume: cream body, red comb, a beak, side wings, the
// hog face under it, orange feet, a russet tail (ref: costume.png).

const CHICK = {
  out: 0x2a2018,
  body: 0xf0e9da,
  bodyDk: 0xd6cdba,
  wing: 0xfbf6ec,
  comb: 0xd0442a,
  combDk: 0xa8331e,
  beak: 0xe6a62d,
  beakDk: 0xc6861a,
  tail: 0xb4541f,
  face: 0xe9d1a2,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

function featherMarks(p: PixelSink, c: typeof CHICK, cy: number): void {
  const marks: [number, number][] = [[10, 0], [16, 1], [21, 3], [12, 4], [19, 5], [15, 6]];
  for (const [x, dy] of marks) { dot(p, x, cy + dy, c.out, 150); dot(p, x + 1, cy + dy + 1, c.bodyDk); }
}

function chickenDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = CHICK;
  const b = bodyBob(frame);
  groundShadow(p, 10.5, 3.2);
  blob(p, 13, FEET_Y + footLift(frame, true), 2, 1.8, c.beak, c.out);
  blob(p, 19, FEET_Y + footLift(frame, false), 2, 1.8, c.beak, c.out);

  if (view === "up") {
    blob(p, 15.5, 27 + b, 10, 9, c.body, c.out);
    disc(p, 15.5, 30 + b, 6, 5, c.bodyDk);
    featherMarks(p, c, 24 + b);
    blob(p, 6, 33 + b, 2.6, 2.2, c.tail, c.out); // tail
    blob(p, 4.6, 31 + b, 2, 1.8, c.tail, c.out);
    dot(p, 14, 10 + b, c.comb); dot(p, 15.5, 9 + b, c.comb); dot(p, 17, 10 + b, c.comb);
    return;
  }

  // russet tail behind
  blob(p, 5, 28 + b, 2.6, 3, c.tail, c.out);
  blob(p, 4, 31 + b, 2.2, 2.4, c.tail, c.out);
  // body
  blob(p, 15.5, 28 + b, 10, 9, c.body, c.out);
  disc(p, 15.5, 30 + b, 6.4, 5.2, c.bodyDk);
  featherMarks(p, c, 27 + b);
  // wings at the sides
  blob(p, 6.5, 27 + b, 2.6, 4, c.wing, c.out);
  blob(p, 24.5, 27 + b, 2.6, 4, c.wing, c.out);
  // comb
  blob(p, 13.5, 10 + b, 1.6, 2, c.comb, c.combDk);
  blob(p, 15.5, 9 + b, 1.8, 2.4, c.comb, c.combDk);
  blob(p, 17.5, 10 + b, 1.6, 2, c.comb, c.combDk);
  // hog face under a beak
  disc(p, 15.5, 17 + b, 5, 4.2, c.face);
  blob(p, 13, 16.5 + b, 1, 1.2, c.eye, c.eye);
  blob(p, 18, 16.5 + b, 1, 1.2, c.eye, c.eye);
  dot(p, 12.6, 15.6 + b, 0xffffff); dot(p, 17.6, 15.6 + b, 0xffffff);
  // beak
  blob(p, 15.5, 19.5 + b, 2.4, 1.4, c.beak, c.beakDk);
  dot(p, 15.5, 20.2 + b, c.beakDk);

  if (view === "side") {
    blob(p, 21, 18 + b, 2.6, 1.6, c.beak, c.beakDk);
  }
}

// ── ghost (cosmetic easter egg) ────────────────────────────────────────────────
// A hog draped in a pale sheet: two ear bumps poke up, two dark eye holes, a
// scalloped hem, two stubby feet (ref: ghost.png). One frame, never tinted.

const GHOST = {
  sheet: 0xf7f5ec,
  sheetLt: 0xffffff,
  shade: 0xd6d6cf,
  out: 0x181818,
  eye: 0x1c140c,
  foot: 0x9c6f3f,
  face: 0xe9d1a2,
  faceDk: 0xcaa86c,
} as const;

function ghostDrawArt(p: PixelSink): void {
  const g = GHOST;
  groundShadow(p, 12, 3.4);
  blob(p, 12, FEET_Y, 2.1, 1.9, g.foot, g.out);
  blob(p, 19, FEET_Y, 2.1, 1.9, g.foot, g.out);
  // a sliver of quill showing under the hem
  disc(p, 15.5, 36, 7, 2.2, g.faceDk, 120);
  // draped body + domed head
  blob(p, 15.5, 27, 11.6, 11.4, g.sheet, g.out);
  disc(p, 15.5, 16, 9.4, 7.6, g.sheet);
  topLight(p, 15.5, 13, 8.5, 5, g.sheetLt, 120);
  // ear bumps poking through
  blob(p, 9, 11, 2.6, 3, g.face, g.out);
  blob(p, 22, 11, 2.6, 3, g.face, g.out);
  disc(p, 9, 11.6, 1.4, 1.6, g.faceDk);
  disc(p, 22, 11.6, 1.4, 1.6, g.faceDk);
  // face windows + eyes
  blob(p, 12, 20, 3, 4.4, g.face, g.out);
  blob(p, 19, 20, 3, 4.4, g.face, g.out);
  blob(p, 12, 19, 1.3, 1.7, g.eye, g.eye); dot(p, 11.4, 18, g.sheetLt);
  blob(p, 19, 19, 1.3, 1.7, g.eye, g.eye); dot(p, 18.4, 18, g.sheetLt);
  dot(p, 15.5, 24, g.out);
  // side drapes + folds
  disc(p, 7, 30, 2.6, 6, g.shade);
  disc(p, 24, 30, 2.6, 6, g.shade);
  line(p, 5, 18, 4, 36, g.out);
  line(p, 26, 18, 27, 36, g.out);
  // scalloped hem
  for (let x = 6; x <= 25; x += 4) {
    disc(p, x, 36, 1.8, 1.4, g.sheet);
    dot(p, x + 2, 37, g.out); dot(p, x + 2, 38, g.shade);
  }
}

// ── frame painting + quantising ────────────────────────────────────────────────

function paintFrame(kind: Kind, style: string, facing: Facing, frame: FrameName): Uint8Array {
  const data = new Uint8Array(FRAME_W * FRAME_H * 4);
  const base = rgbaSink(data, FRAME_W, FRAME_H);
  const flip = facing === "left";
  const p: PixelSink = { set: (x, y, c, a) => base.set(flip ? FRAME_W - 1 - x : x, y, c, a) };
  const view: View = facing === "left" || facing === "right" ? "side" : facing;
  if (kind === "trogg") troggDraw(p, view, frame, TROGG_SKINS[style] ?? TROGG_SKINS.moss!);
  else if (style === "buff") buffDraw(p, view, frame);
  else if (style === "dino") dinoDraw(p, view, frame);
  else if (style === "chicken") chickenDraw(p, view, frame);
  else hogDraw(p, view, frame, HOG_SKINS[style] ?? HOG_SKINS.classic!);
  return data;
}

interface IndexedArt {
  palette: number[];
  pixels: string[];
}

function quantize(data: Uint8Array): IndexedArt {
  const palette: number[] = [];
  const index = new Map<number, number>();
  const pixels: string[] = [];
  for (let y = 0; y < FRAME_H; y++) {
    let row = "";
    for (let x = 0; x < FRAME_W; x++) {
      const i = (y * FRAME_W + x) * 4;
      const a = data[i + 3]!;
      if (a === 0) { row += "."; continue; }
      const rgba = data[i]! * 0x1000000 + data[i + 1]! * 0x10000 + data[i + 2]! * 0x100 + a;
      let idx = index.get(rgba);
      if (idx === undefined) {
        idx = palette.length;
        if (idx >= PIXEL_KEYS.length) throw new Error(`frame needs more than ${PIXEL_KEYS.length} colours`);
        palette.push(rgba);
        index.set(rgba, idx);
      }
      row += PIXEL_KEYS[idx];
    }
    pixels.push(row);
  }
  return { palette, pixels };
}

function paintGhost(): Uint8Array {
  const data = new Uint8Array(FRAME_W * FRAME_H * 4);
  ghostDrawArt(rgbaSink(data, FRAME_W, FRAME_H));
  return data;
}

// ── emit ──────────────────────────────────────────────────────────────────────

function fmtArt(art: IndexedArt, indent: string): string {
  const pal = art.palette.map((n) => "0x" + (n >>> 0).toString(16).padStart(8, "0")).join(", ");
  const rows = art.pixels.map((r) => `${indent}  ${JSON.stringify(r)}`).join(",\n");
  return `{ palette: [${pal}], pixels: [\n${rows}\n${indent}] }`;
}

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
  const art = quantize(paintFrame(f.kind, f.style, f.facing, f.frame));
  return `  ${JSON.stringify(f.name)}: ${fmtArt(art, "  ")},`;
});

const ghost = fmtArt(quantize(paintGhost()), "");

const out =
  header +
  `export const AVATAR_FRAME_ART: Record<string, IndexedSpriteArt> = {\n${entries.join("\n")}\n};\n\n` +
  `export const GHOST_ART: IndexedSpriteArt = ${ghost};\n`;

const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "sprite_art.ts");
writeFileSync(OUT_PATH, out);
console.log(`Wrote ${entries.length} frames + ghost → ${OUT_PATH}`);
