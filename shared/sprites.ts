/**
 * Concept-inspired pixel art for the trogg and Hog avatars (GDD "Avatars and
 * equipment"; pillar 5 — programmer pixel art, polish deferred). Pure paint
 * logic: a single `paintSheet` walks a grid of frames and calls a `set(x, y,
 * colour, alpha?)` callback for each art pixel, exactly like `terrain.ts` paints
 * tiles. The callback owns the surface (a Node RGBA buffer for the generated
 * sprite-sheet PNG, a `<canvas>` ImageData for a future client renderer) and any
 * alpha blending, so this file stays free of DOM and Node deps and is shared
 * design data — like the `ZONES` registry — not client- or server-specific code.
 *
 * The rig follows the GDD: troggs and Hogs share one frame layout, drawn per
 * facing (down/up/left/right) and per animation frame (idle, a two-step walk,
 * and a two-step hunched run for the shift-to-run mechanic — GDD "Movement").
 * The atlas is laid out as columns = frames, rows grouped by kind then facing, so
 * `frameRect` maps a `(kind, facing, frame)` to its cell. Frames are anchored at
 * the feet (`ANCHOR`) so a sprite drops onto a tile by its base, head room up.
 *
 * This is the avatar *base body* only. Held-item and armour overlays (GDD
 * per-hand layers) reuse the same frame grid and anchor when they land; the rig
 * reserves their order now. Rendering can fall back to the placeholder marker
 * when sprite avatars are disabled.
 */

export type Kind = "trogg" | "hog";
export type Facing = "down" | "up" | "left" | "right";
export type FrameName = "idle" | "walk_a" | "walk_b" | "run_a" | "run_b";

/**
 * Cosmetic body variants within a kind (GDD "Avatars and equipment"). A style
 * changes the silhouette features and base palette — not the rig — so every style
 * shares one frame layout, anchor, and animation. Troggs choose a style (the
 * `restyle` reducer, like `recolor`); Hogs get one derived from their id, so a
 * zone's Hogs read as a varied crowd. The first entry of each list is the default
 * (the unchosen / id-derived fallback resolves through it).
 */
export const TROGG_STYLES = ["moss", "stone", "ridge"] as const;
/** Every hog style painted into the sheet. The common three fill the random roaming
 *  crowd; the big two (buff, dino) are placed showpieces that span a 2×2 footprint
 *  and render at double size; the chicken is an easter egg, summoned, never random. */
export const HOG_STYLES = ["classic", "snow", "ember", "buff", "dino", "chicken"] as const;
/** The small hogs that fill the id-derived random crowd (see `hogStyleFor`). */
export const COMMON_HOG_STYLES = ["classic", "snow", "ember"] as const;
/** Hogs that occupy a 2×2 tile footprint and render at double size (GDD "Hogs"). */
export const BIG_HOG_STYLES = ["buff", "dino"] as const;
export type TroggStyle = (typeof TROGG_STYLES)[number];
export type HogStyle = (typeof HOG_STYLES)[number];
export type Style = TroggStyle | HogStyle;

/** A hog style's tile-footprint span: 2 for the big showpieces, 1 for the rest. */
export function hogSize(style: string): number {
  return (BIG_HOG_STYLES as readonly string[]).includes(style) ? 2 : 1;
}

/** The styles a kind offers, default first. */
export function stylesOf(kind: Kind): readonly string[] {
  return kind === "trogg" ? TROGG_STYLES : HOG_STYLES;
}

/** Art pixels per frame. 16 wide matches the tile (`ART` in terrain.ts); the
 *  extra height is 3/4-view head room above the feet anchor. */
export const FRAME_W = 16;
export const FRAME_H = 24;

/** Feet anchor: where the sprite sits on its tile (bottom-centre). */
export const ANCHOR = { x: 8, y: 22 } as const;

export const KINDS: readonly Kind[] = ["trogg", "hog"] as const;
export const FACINGS: readonly Facing[] = ["down", "up", "left", "right"] as const;
export const FRAMES: readonly FrameName[] = ["idle", "walk_a", "walk_b", "run_a", "run_b"] as const;

/** Every (kind, style) row group in sheet order — a kind's styles, then the next
 *  kind's. Each group owns `FACINGS.length` rows. */
export function styleGroups(): { kind: Kind; style: string }[] {
  const out: { kind: Kind; style: string }[] = [];
  for (const kind of KINDS) for (const style of stylesOf(kind)) out.push({ kind, style });
  return out;
}

/** Sheet dimensions: columns = frames, rows = (kind × style) × facing. */
export const SHEET_COLS = FRAMES.length;
export const SHEET_ROWS = styleGroups().length * FACINGS.length;
export const SHEET_W = SHEET_COLS * FRAME_W;
export const SHEET_H = SHEET_ROWS * FRAME_H;

/** A pixel sink. `colour` is 0xRRGGBB; `alpha` is 0–255 (default opaque). The
 *  sink decides how to blend — this module only ever asks to place a pixel. */
export interface PixelSink {
  set(x: number, y: number, colour: number, alpha?: number): void;
}

/**
 * A `PixelSink` that source-over-blends into a flat RGBA byte array — a Node
 * `Uint8Array` (the sprite-sheet generator) or a canvas `ImageData.data` (the
 * client texture builder), so both surfaces blend identically. `data` must be
 * `width * height * 4` bytes, zeroed for a transparent start.
 */
export function rgbaSink(data: Uint8Array | Uint8ClampedArray, width: number, height: number): PixelSink {
  return {
    set(x, y, colour, alpha = 255) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      const sa = alpha / 255;
      const da = data[i + 3]! / 255;
      const oa = sa + da * (1 - sa); // resulting alpha
      if (oa === 0) return;
      const blend = (s: number, d: number) => Math.round((s * sa + d * da * (1 - sa)) / oa);
      data[i] = blend((colour >> 16) & 0xff, data[i]!);
      data[i + 1] = blend((colour >> 8) & 0xff, data[i + 1]!);
      data[i + 2] = blend(colour & 0xff, data[i + 2]!);
      data[i + 3] = Math.round(oa * 255);
    },
  };
}

/** The cell for one frame in the sheet, in art pixels. */
export interface FrameRect {
  name: string;
  kind: Kind;
  style: string;
  facing: Facing;
  frame: FrameName;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stable frame key used in the atlas, e.g. `trogg_moss_down_walk_a`. */
export function frameName(kind: Kind, style: string, facing: Facing, frame: FrameName): string {
  return `${kind}_${style}_${facing}_${frame}`;
}

/** Where a given frame lives in the sheet. Row = style-group block + facing offset. */
export function frameRect(kind: Kind, style: string, facing: Facing, frame: FrameName): FrameRect {
  const group = styleGroups().findIndex((g) => g.kind === kind && g.style === style);
  const row = group * FACINGS.length + FACINGS.indexOf(facing);
  const col = FRAMES.indexOf(frame);
  return {
    name: frameName(kind, style, facing, frame),
    kind,
    style,
    facing,
    frame,
    x: col * FRAME_W,
    y: row * FRAME_H,
    w: FRAME_W,
    h: FRAME_H,
  };
}

/** Every frame rect, row-major — the full atlas. */
export function frames(): FrameRect[] {
  const out: FrameRect[] = [];
  for (const { kind, style } of styleGroups()) for (const facing of FACINGS) for (const frame of FRAMES) {
    out.push(frameRect(kind, style, facing, frame));
  }
  return out;
}

/** Paint the whole sheet by drawing each frame into its cell. */
export function paintSheet(sink: PixelSink): void {
  for (const f of frames()) paintFrame(sink, f.kind, f.style, f.facing, f.frame, f.x, f.y);
}

// ── palettes ────────────────────────────────────────────────────────────────
// Earthy, torch-lit tones that sit with the cave terrain palette (terrain.ts).

const SHADOW = 0x000000;

/** A trogg skin: its palette plus the head crest that marks the style apart. */
interface TroggSkin {
  out: number;
  body: number;
  light: number;
  shade: number;
  belly: number;
  eye: number;
  pupil: number;
  mouth: number;
  /** What sits on the crown: soft `ears`, stubby `horns`, or a craggy earless head. */
  crest: "ears" | "horns" | "none";
}

const TROGG_SKINS: Record<string, TroggSkin> = {
  // Moss-stained stone hide, red eyes, soft ear nubs — the default cave-dweller.
  moss: { out: 0x211f18, body: 0x74765a, light: 0xa9a77a, shade: 0x4b4e3b, belly: 0x8d8963, eye: 0xff3b28, pupil: 0x2a0a06, mouth: 0x17140f, crest: "ears" },
  // Cold grey stone brute with a craggy, earless skull.
  stone: { out: 0x191b1c, body: 0x6f7168, light: 0xa7a58b, shade: 0x3f4440, belly: 0x86806b, eye: 0xff3328, pupil: 0x270806, mouth: 0x141414, crest: "none" },
  // Dark ridge-back, heavier brow, and small horn nubs.
  ridge: { out: 0x16120c, body: 0x625a3d, light: 0xb29d68, shade: 0x3e3928, belly: 0x806f4a, eye: 0xff442c, pupil: 0x260906, mouth: 0x15100a, crest: "horns" },
};

/** A hog skin: quill, face, and accent palette. Hogs share one shape, so the
 *  palette is what tells a zone's Hogs apart. */
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
}

const HOG_SKINS: Record<string, HogSkin> = {
  // Warm brown quills, cream face — the classic hedgehog.
  classic: { out: 0x2a1d10, quill: 0x6e5334, quillLt: 0x916f44, quillDk: 0x40301c, face: 0xe3cf9f, faceLt: 0xf2e4c2, faceDk: 0xc8a86e, nose: 0x241710, eye: 0x1c140c, glint: 0xece0c6 },
  // Pale ash-grey quills, frost-cream face — the snowy hog.
  snow: { out: 0x2b2a2d, quill: 0x9a9aa2, quillLt: 0xc2c2c8, quillDk: 0x6c6c74, face: 0xeae3d8, faceLt: 0xf6f1ea, faceDk: 0xc8bca8, nose: 0x3a2a2a, eye: 0x201a1a, glint: 0xf2eee6 },
  // Rust-red quills, toasted face — the ember hog.
  ember: { out: 0x2c160c, quill: 0x9c4e2a, quillLt: 0xc46a38, quillDk: 0x5f2c16, face: 0xe6c79a, faceLt: 0xf3dcb4, faceDk: 0xc79a64, nose: 0x2a1208, eye: 0x1c100a, glint: 0xeed8b6 },
};

// ── primitives ────────────────────────────────────────────────────────────────

/** Offsets + clips a sink to one frame cell, and flips x for left-facing so the
 *  right-facing profile is authored once and mirrored. */
function cell(sink: PixelSink, ox: number, oy: number, flip: boolean): PixelSink {
  return {
    set(x, y, colour, alpha) {
      if (x < 0 || y < 0 || x >= FRAME_W || y >= FRAME_H) return;
      const fx = flip ? FRAME_W - 1 - x : x;
      sink.set(ox + fx, oy + y, colour, alpha);
    },
  };
}

function dot(p: PixelSink, x: number, y: number, colour: number, alpha?: number): void {
  p.set(Math.round(x), Math.round(y), colour, alpha);
}

function rect(p: PixelSink, x: number, y: number, w: number, h: number, colour: number, alpha?: number): void {
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) p.set(x + xx, y + yy, colour, alpha);
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

/** Filled ellipse centred at (cx, cy) with radii (rx, ry). Centres may be
 *  fractional (e.g. 7.5) to sit symmetrically across the 16-wide frame. */
function disc(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number, alpha?: number): void {
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) p.set(x, y, colour, alpha);
    }
  }
}

/** Filled ellipse with a 1px dark rim — cheap, readable pixel-art outline. */
function blob(p: PixelSink, cx: number, cy: number, rx: number, ry: number, fill: number, out: number): void {
  disc(p, cx, cy, rx + 0.85, ry + 0.85, out);
  disc(p, cx, cy, rx, ry, fill);
}

// ── animation ────────────────────────────────────────────────────────────────

/** Whether a frame is part of the run cycle (vs walk or idle). */
function isRun(frame: FrameName): boolean {
  return frame === "run_a" || frame === "run_b";
}

/** Which foot leads this stride frame: +1 on the `_a` frames, -1 on `_b`, 0 idle.
 *  Shared by walk and run so limbs swing the same way, just further when running. */
function stride(frame: FrameName): number {
  if (frame === "walk_a" || frame === "run_a") return 1;
  if (frame === "walk_b" || frame === "run_b") return -1;
  return 0;
}

/** Vertical foot offset for a stride frame; left/right feet alternate lifting,
 *  higher on a run than a walk. */
function footLift(frame: FrameName, left: boolean): number {
  const lift = isRun(frame) ? -2 : -1;
  const s = stride(frame);
  if (s > 0) return left ? lift : 0;
  if (s < 0) return left ? 0 : lift;
  return 0;
}

/** Body bob as the avatar strides — 1px on a walk, 2px on a run's harder push-off. */
function bodyBob(frame: FrameName): number {
  if (frame === "idle") return 0;
  return isRun(frame) ? -2 : -1;
}

/** Forward hunch when running: the side profile pitches into the run, head and
 *  torso shifting toward the facing direction (right, pre-mirror). Walk and idle
 *  stand upright. Front/back views can't show a lean, so they only crouch. */
const RUN_LEAN = 2;

// ── frame dispatch ───────────────────────────────────────────────────────────

function paintFrame(sink: PixelSink, kind: Kind, style: string, facing: Facing, frame: FrameName, ox: number, oy: number): void {
  const flip = facing === "left";
  const p = cell(sink, ox, oy, flip);
  // left is the mirror of right, so author both profiles as "side".
  const view = facing === "left" || facing === "right" ? "side" : facing;
  if (kind === "trogg") troggDraw(p, view, frame, TROGG_SKINS[style] ?? TROGG_SKINS.moss!);
  else hogPaint(p, view, frame, style);
}

/** Dispatch a hog frame: the bespoke showpieces have their own shapes; the common
 *  styles share one body painted with their palette. */
function hogPaint(p: PixelSink, view: View, frame: FrameName, style: string): void {
  if (style === "buff") return buffDraw(p, view, frame);
  if (style === "dino") return dinoDraw(p, view, frame);
  if (style === "chicken") return chickenDraw(p, view, frame);
  hogDraw(p, view, frame, HOG_SKINS[style] ?? HOG_SKINS.classic!);
}

type View = "down" | "up" | "side";

/** Soft contact shadow under the feet, shared by both characters. */
function groundShadow(p: PixelSink, rx = 5, ry = 1.6): void {
  disc(p, 7.5, 21, rx, ry, SHADOW, 70);
}

/** Two feet, with the walk lift applied. `y` is the planted baseline. */
function feet(p: PixelSink, frame: FrameName, colour: number, out: number, y: number, lx: number, rx: number): void {
  blob(p, lx, y + footLift(frame, true), 1.4, 1.1, colour, out);
  blob(p, rx, y + footLift(frame, false), 1.4, 1.1, colour, out);
}

// ── trogg ────────────────────────────────────────────────────────────────────
// A small, big-headed cave-dweller: round body, oversized glowing eyes. Styles
// swap the palette and the head crest (ears / horns / earless crag).

/**
 * The crown ornament that distinguishes a trogg style. `lean` shifts the side
 * profile when running (mirrored with the sprite). `ears` are soft body-coloured
 * nubs (the default look), `horns` are lighter and tipped, `none` leaves a craggy
 * earless head with a couple of shade lumps so the stone style reads as rock.
 */
function troggCrest(p: PixelSink, c: TroggSkin, view: View, hb: number, lean: number): void {
  if (c.crest === "none") {
    if (view !== "side") {
      dot(p, 3, 5 + hb, c.light);
      dot(p, 12, 5 + hb, c.light);
      dot(p, 4, 4 + hb, c.out);
      dot(p, 11, 4 + hb, c.out);
    }
    return;
  }
  const horns = c.crest === "horns";
  const fill = horns ? c.light : c.body;
  const ry = horns ? 1.5 : 1.8;
  if (view === "side") {
    blob(p, 3 + lean, 7 + hb, 1.2, ry, fill, c.out);
    if (horns) dot(p, 3 + lean, 4 + hb, c.out);
    return;
  }
  const lx = horns ? 3.2 : 2.8;
  const rx = horns ? 11.8 : 12.2;
  blob(p, lx, 6.7 + hb, 1.2, ry, fill, c.out);
  blob(p, rx, 6.7 + hb, 1.2, ry, fill, c.out);
  if (horns) { dot(p, lx, 4 + hb, c.out); dot(p, rx, 4 + hb, c.out); }
}

function troggTexture(p: PixelSink, c: TroggSkin, ox = 0, oy = 0): void {
  const flecks: [number, number][] = [
    [4, 6], [8, 5], [12, 7], [5, 11], [11, 10], [3, 15], [8, 16], [12, 14],
    [5, 19], [10, 19], [6, 13], [9, 8],
  ];
  for (const [x, y] of flecks) dot(p, x + ox, y + oy, (x + y) % 2 === 0 ? c.light : c.shade, 150);
}

function troggHand(p: PixelSink, x: number, y: number, c: TroggSkin): void {
  blob(p, x, y, 1.4, 1.2, c.light, c.out);
  dot(p, x - 1, y + 1, c.out);
  dot(p, x, y + 1, c.out);
  dot(p, x + 1, y + 1, c.out);
}

function troggFaceDown(p: PixelSink, c: TroggSkin, hb: number): void {
  blob(p, 7.5, 8 + hb, 5.8, 4.6, c.body, c.out);
  troggCrest(p, c, "down", hb, 0);
  disc(p, 7.5, 5.5 + hb, 3.6, 1.4, c.light);
  // heavy brow shelves above square red eyes
  rect(p, 4, 7 + hb, 3, 1, c.out);
  rect(p, 9, 7 + hb, 3, 1, c.out);
  rect(p, 5, 8 + hb, 2, 2, c.eye);
  rect(p, 10, 8 + hb, 2, 2, c.eye);
  dot(p, 6, 8 + hb, c.pupil);
  dot(p, 11, 8 + hb, c.pupil);
  // broad nose bridge, open dark mouth, little teeth
  rect(p, 7, 10 + hb, 2, 1, c.shade);
  rect(p, 6, 12 + hb, 4, 2, c.mouth);
  dot(p, 6, 11 + hb, c.light);
  dot(p, 9, 11 + hb, c.light);
  dot(p, 6, 14 + hb, 0xf0e7cf);
  dot(p, 9, 14 + hb, 0xf0e7cf);
}

const troggDraw = (p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void => {
  const b = bodyBob(frame);
  const run = isRun(frame);
  const crouch = run ? 1 : 0;
  const hb = b + crouch;
  const lean = view === "side" && run ? RUN_LEAN : 0;
  groundShadow(p, run ? 5.8 : 5.2, 1.7);
  feet(p, frame, c.shade, c.out, 20, run ? 4.8 : 5.2, run ? 10.4 : 9.8);

  if (view === "side") {
    const swing = stride(frame) * (run ? 2 : 1);
    // crouched back, sunken belly, and long arms echo the reference trogg pose.
    blob(p, 7 + lean * 0.3, 14 + b, 4.5, 5.1, c.body, c.out);
    disc(p, 6, 15 + b, 2.4, 2.4, c.belly);
    line(p, 4, 13 + b, 9, 13 + b, c.shade);
    line(p, 5, 15 + b, 9, 15 + b, c.shade);
    blob(p, 8.8 + lean, 8.5 + hb, 5.3, 4.2, c.body, c.out);
    disc(p, 6.8 + lean, 6.3 + hb, 2.8, 1.6, c.light);
    troggCrest(p, c, "side", hb, lean);
    blob(p, 3.8, 12 + b, 1.8, 3.4, c.shade, c.out);
    line(p, 3, 14 + b, 3, 18 + b + swing * 0.5, c.shade);
    troggHand(p, 3, 18 + b + swing * 0.5, c);
    line(p, 9, 14 + b, 12, 16 + b + swing, c.shade);
    troggHand(p, 12, 16 + b + swing, c);
    rect(p, 11 + lean, 8 + hb, 2, 2, c.eye);
    dot(p, 12 + lean, 8 + hb, c.pupil);
    rect(p, 12 + lean, 11 + hb, 2, 2, c.mouth);
    dot(p, 13 + lean, 10 + hb, c.light);
    dot(p, 13 + lean, 13 + hb, 0xf0e7cf);
    troggTexture(p, c);
    return;
  }

  // broad chest, hunched shoulders, and dangling long arms for the camera-facing views
  blob(p, 7.5, 15 + b, 4.6, 4.4, c.body, c.out);
  disc(p, 7.5, 16 + b, 2.6, 2.7, c.belly);
  blob(p, 4, 13 + b, 1.8, 2.6, c.shade, c.out);
  blob(p, 11, 13 + b, 1.8, 2.6, c.shade, c.out);
  line(p, 3, 15 + b, 2, 18 + b + stride(frame), c.shade);
  line(p, 12, 15 + b, 13, 18 + b - stride(frame), c.shade);
  troggHand(p, 2, 18 + b + stride(frame), c);
  troggHand(p, 13, 18 + b - stride(frame), c);
  line(p, 5, 14 + b, 10, 14 + b, c.shade);

  if (view === "up") {
    blob(p, 7.5, 8 + hb, 5.6, 4.4, c.body, c.out);
    disc(p, 7.5, 6 + hb, 3.5, 1.8, c.light);
    troggCrest(p, c, "up", hb, 0);
    rect(p, 7, 10 + hb, 2, 5, c.shade);
    troggTexture(p, c);
    return;
  }

  troggFaceDown(p, c, hb);
  troggTexture(p, c);
};

// ── hog ──────────────────────────────────────────────────────────────────────
// A friendly hedgehog: cream snout and belly, a spiky quill dome over the back.

/** Quills: a soft cloak of colour, with short dash marks like the mascot references. */
function quillDome(p: PixelSink, cx: number, cy: number, rx: number, ry: number, h: HogSkin): void {
  blob(p, cx, cy, rx, ry, h.quill, h.out);
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      const k = (x * 5 + y * 3) % 7;
      if (k === 0) line(p, x - 0.4, y, x + 0.4, y, h.quillDk);
      else if (k === 3) dot(p, x, y, h.quillLt, 120);
    }
  }
}

function hogEar(p: PixelSink, x: number, y: number, h: HogSkin): void {
  blob(p, x, y, 1.3, 1.3, h.face, h.out);
  disc(p, x, y, 0.7, 0.7, h.faceDk);
}

function hogArm(p: PixelSink, x: number, y: number, dir: -1 | 1, h: HogSkin): void {
  line(p, x, y, x + dir * 1.8, y + 2.2, h.faceDk);
  blob(p, x + dir * 2, y + 2.4, 0.8, 0.9, h.faceDk, h.out);
}

function hogFaceFront(p: PixelSink, h: HogSkin, y: number, mood: "open" | "smile" = "open"): void {
  disc(p, 7.5, y, 3.4, 2.7, h.faceLt);
  // small shiny eyes
  for (const ex of [5.6, 9.4]) {
    dot(p, ex, y - 1.4, h.eye);
    dot(p, ex, y - 0.4, h.eye);
    dot(p, ex, y - 1.8, h.glint);
  }
  // muzzle bridge and nose
  line(p, 5.5, y + 1, 7.5, y, h.out);
  line(p, 9.5, y + 1, 7.5, y, h.out);
  dot(p, 7.5, y + 0.5, h.nose);
  if (mood === "smile") {
    dot(p, 6.8, y + 1.5, h.out);
    dot(p, 8.2, y + 1.5, h.out);
  } else {
    rect(p, 7, y + 1.5, 1, 2, h.out);
  }
}

const hogDraw = (p: PixelSink, view: View, frame: FrameName, h: HogSkin): void => {
  const b = bodyBob(frame);
  groundShadow(p, 5.6, 1.7);
  feet(p, frame, h.faceDk, h.out, 20, 5.6, 9.4);

  if (view === "side") {
    // rounded body with the quill cloak sweeping behind, snout in front.
    quillDome(p, 5.5, 12 + b, 4.4, 6, h);
    blob(p, 8.4, 15 + b, 4.4, 3.8, h.face, h.out);
    disc(p, 8.5, 16 + b, 2.7, 2.3, h.faceLt);
    hogEar(p, 9.7, 8.2 + b, h);
    blob(p, 10, 11 + b, 3, 2.8, h.face, h.out);
    blob(p, 12.6, 12 + b, 1.9, 1.4, h.faceLt, h.out);
    dot(p, 14, 12 + b, h.nose);
    rect(p, 11, 10 + b, 1, 2, h.eye);
    dot(p, 11, 10 + b, h.glint);
    hogArm(p, 9, 14 + b, 1, h);
    return;
  }

  if (view === "up") {
    quillDome(p, 7.5, 12 + b, 6.5, 6.4, h);
    hogEar(p, 4.4, 7 + b, h);
    hogEar(p, 10.6, 7 + b, h);
    disc(p, 7.5, 16 + b, 3.7, 2.5, h.faceDk, 90);
    return;
  }

  quillDome(p, 7.5, 10 + b, 6.4, 6.2, h);
  hogEar(p, 4.4, 6.8 + b, h);
  hogEar(p, 10.6, 6.8 + b, h);
  blob(p, 7.5, 15 + b, 4.8, 3.8, h.face, h.out);
  disc(p, 7.5, 16 + b, 3.1, 2.4, h.faceLt);
  hogArm(p, 3.5, 13.5 + b, -1, h);
  hogArm(p, 11.5, 13.5 + b, 1, h);
  blob(p, 7.5, 10 + b, 3.7, 3.2, h.face, h.out);
  hogFaceFront(p, h, 10 + b, "open");
};

// ── buff hog ────────────────────────────────────────────────────────────────────
// A swole hedgehog throwing a double-biceps flex (GDD "Hogs": big showpiece, 2×2).
// Authored at the shared 16×24 and rendered at double size, so it reads huge.

const BUFF = {
  out: 0x2a1d10,
  skin: 0xcaa06a, // tan muscle
  skinLt: 0xe3c089,
  skinDk: 0x9c7038,
  face: 0xf2e4c2,
  quill: 0x6e5334,
  quillDk: 0x40301c,
  eye: 0x1c140c,
} as const;

const buffDraw = (p: PixelSink, view: View, frame: FrameName): void => {
  const c = BUFF;
  const b = bodyBob(frame);
  groundShadow(p, 6.2, 1.9);
  feet(p, frame, c.skinDk, c.out, 20, 5, 10);
  blob(p, 5.6, 17 + b, 1.8, 2.4, c.skin, c.out);
  blob(p, 9.4, 17 + b, 1.8, 2.4, c.skin, c.out);

  if (view === "up") {
    quillDome(p, 7.5, 7 + b, 3.2, 2.5, HOG_SKINS.classic!);
    blob(p, 7.5, 12.5 + b, 5.8, 4.6, c.skin, c.out);
    rect(p, 7, 9 + b, 2, 6, c.skinDk);
    blob(p, 2.2, 9 + b, 2, 3.2, c.skin, c.out);
    blob(p, 12.8, 9 + b, 2, 3.2, c.skin, c.out);
    return;
  }

  const side = view === "side";
  quillDome(p, 7.5, 5.5 + b, 3, 2.4, HOG_SKINS.classic!);
  blob(p, 7.5, 12.8 + b, side ? 4.8 : 5.6, 4.4, c.skin, c.out);
  disc(p, 5.5, 12 + b, 1.8, 1.5, c.skinLt);
  disc(p, 9.5, 12 + b, 1.8, 1.5, c.skinLt);
  line(p, 7.5, 12 + b, 7.5, 17 + b, c.out);
  line(p, 5.5, 15 + b, 9.5, 15 + b, c.skinDk);
  dot(p, 6.7, 16 + b, c.skinDk);
  dot(p, 8.3, 16 + b, c.skinDk);
  for (const s of [-1, 1]) {
    const sx = 7.5 + s * 4;
    blob(p, sx, 10.5 + b, 2.2, 2.6, c.skinDk, c.out);
    blob(p, sx - s * 1, 7.2 + b, 1.6, 1.8, c.skinLt, c.out);
    dot(p, sx - s * 1.2, 6 + b, c.out);
  }
  disc(p, 7.5, 7.7 + b, 2.3, 1.9, c.face);
  dot(p, 6.6, 7.5 + b, c.eye);
  dot(p, 8.4, 7.5 + b, c.eye);
  line(p, 6.7, 8.7 + b, 8.3, 8.7 + b, c.out);
};

// ── dino hog ────────────────────────────────────────────────────────────────────
// A hedgehog in a T-rex costume — green body, toothy hood, the hog face in the maw
// (GDD "Hogs": big showpiece, 2×2). Like buff, authored at 16×24 and rendered double.

const DINO = {
  out: 0x17250f,
  body: 0x748b32,
  bodyLt: 0xa2ad45,
  bodyDk: 0x465b1f,
  belly: 0xc3bf6e,
  face: 0xf2e4c2,
  tooth: 0xf3eedf,
  eye: 0x1c140c,
} as const;

/** Sawtooth dino ridge along an arc — the costume's spiky back. */
function dinoRidge(p: PixelSink, cx: number, top: number, span: number, dk: number): void {
  for (let x = cx - span; x <= cx + span; x += 2) {
    dot(p, x, top - 1, dk);
    dot(p, x, top, dk);
  }
}

function dinoScales(p: PixelSink, c: typeof DINO, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0 + (y % 4 === 0 ? 0 : 1); x <= x1; x += 3) {
      dot(p, x, y, c.out, 150);
      dot(p, x, y - 1, c.bodyLt, 120);
    }
  }
}

const dinoDraw = (p: PixelSink, view: View, frame: FrameName): void => {
  const c = DINO;
  const b = bodyBob(frame);
  groundShadow(p, 6.4, 1.9);
  feet(p, frame, c.bodyDk, c.out, 20, 5, 10);

  if (view === "up") {
    blob(p, 7.5, 13 + b, 5.8, 4.8, c.body, c.out);
    rect(p, 7, 9 + b, 2, 6, c.bodyDk); // spine
    dinoRidge(p, 7.5, 9 + b, 4, c.bodyDk);
    dinoScales(p, c, 4, 11 + b, 11, 17 + b);
    blob(p, 2.2, 16 + b, 2.4, 1.4, c.bodyDk, c.out);
    return;
  }

  if (view === "side") {
    blob(p, 2.2, 15.5 + b, 3, 1.6, c.body, c.out);
    dot(p, 0.5, 15 + b, c.out);
    blob(p, 7.5, 13 + b, 4.8, 4.1, c.body, c.out);
    disc(p, 8, 14.5 + b, 2.6, 2.2, c.belly);
    dinoScales(p, c, 4, 11 + b, 10, 16 + b);
    blob(p, 4, 12 + b, 1, 1.5, c.bodyDk, c.out);
    dinoRidge(p, 6.5, 9 + b, 4, c.bodyDk);
    blob(p, 11.3, 10.5 + b, 3.4, 2.8, c.body, c.out);
    rect(p, 9, 11 + b, 6, 1, c.out);
    for (let x = 9; x <= 14; x += 2) {
      dot(p, x, 10 + b, c.tooth);
      dot(p, x + 1, 12 + b, c.tooth);
    }
    disc(p, 11.3, 11.7 + b, 1.2, 1, c.face);
    dot(p, 12, 11.5 + b, c.eye);
    dot(p, 12.6, 8.4 + b, c.eye);
    return;
  }

  blob(p, 7.5, 14 + b, 5.7, 4.6, c.body, c.out);
  disc(p, 7.5, 15 + b, 3, 2.6, c.belly);
  dinoScales(p, c, 4, 12 + b, 11, 17 + b);
  blob(p, 3.4, 13 + b, 1, 1.4, c.bodyDk, c.out);
  blob(p, 11.6, 13 + b, 1, 1.4, c.bodyDk, c.out);
  blob(p, 7.5, 7.8 + b, 4.5, 3.4, c.body, c.out);
  dinoRidge(p, 7.5, 5.3 + b, 4, c.bodyDk);
  dot(p, 5.6, 6.6 + b, c.eye); dot(p, 9.4, 6.6 + b, c.eye);
  rect(p, 4, 9 + b, 7, 1, c.out);
  for (let x = 4; x <= 11; x += 2) dot(p, x, 8 + b, c.tooth);
  disc(p, 7.5, 10.6 + b, 2.2, 1.7, c.face);
  dot(p, 6.7, 10.4 + b, c.eye); dot(p, 8.3, 10.4 + b, c.eye);
  dot(p, 7.5, 11.4 + b, c.out);
};

// ── chicken hog (easter egg) ─────────────────────────────────────────────────────
// A hedgehog in a chicken costume — cream body, red comb, the hog face under a beak
// (GDD "Hogs": easter egg, normal 1×1 size). Authored, summoned, never in the crowd.

const CHICK = {
  out: 0x2a2018,
  body: 0xf0e9da,
  bodyDk: 0xd8cfbc,
  comb: 0xd44a2b,
  beak: 0xe6a62d,
  face: 0xf2e4c2,
  eye: 0x1c140c,
} as const;

function featherMarks(p: PixelSink, c: typeof CHICK, b: number): void {
  const marks: [number, number][] = [[5, 12], [8, 13], [10, 15], [6, 16], [9, 17]];
  for (const [x, y] of marks) {
    dot(p, x, y + b, c.out, 160);
    dot(p, x + 0.5, y + 0.5 + b, c.bodyDk);
  }
}

const chickenDraw = (p: PixelSink, view: View, frame: FrameName): void => {
  const c = CHICK;
  const b = bodyBob(frame);
  groundShadow(p, 5.3, 1.7);
  // orange feet
  blob(p, 6.5, 20, 1, 0.9, c.beak, c.out);
  blob(p, 9, 20, 1, 0.9, c.beak, c.out);

  if (view === "up") {
    blob(p, 7.5, 13 + b, 5, 4.4, c.body, c.out);
    disc(p, 7.5, 15 + b, 3, 2.5, c.bodyDk);
    featherMarks(p, c, b);
    blob(p, 3.7, 16.5 + b, 1.4, 1.2, c.comb, c.out);
    blob(p, 2.8, 15.4 + b, 1.1, 1, c.comb, c.out);
    dot(p, 7, 5 + b, c.comb); dot(p, 7.5, 4.5 + b, c.comb); dot(p, 8, 5 + b, c.comb);
    return;
  }

  blob(p, 7.5, 14 + b, 5, 4.2, c.body, c.out);
  disc(p, 7.5, 15 + b, 3, 2.6, c.bodyDk);
  featherMarks(p, c, b);
  blob(p, 3.2, 13.8 + b, 1.5, 2, c.body, c.out);
  blob(p, 11.8, 13.8 + b, 1.5, 2, c.body, c.out);
  line(p, 3, 14 + b, 2, 12 + b, c.out);
  line(p, 12, 14 + b, 13, 12 + b, c.out);
  blob(p, 3, 12 + b, 1.2, 1.5, c.comb, c.out);
  dot(p, 6.5, 5 + b, c.comb);
  blob(p, 7.5, 4.8 + b, 1, 1.3, c.comb, c.out);
  dot(p, 8.6, 5 + b, c.comb);
  disc(p, 7.5, 9.5 + b, 2.5, 2, c.face);
  dot(p, 6.4, 9.2 + b, c.eye);
  dot(p, 8.6, 9.2 + b, c.eye);
  blob(p, 7.5, 10.6 + b, 1.4, 0.8, c.beak, c.out);
  if (view === "side") {
    dot(p, 10, 9.2 + b, c.eye);
    blob(p, 10.5, 10.5 + b, 1.3, 0.8, c.beak, c.out);
  }
};

// ── ghost ──────────────────────────────────────────────────────────────────────
// The cosmetic ghost easter egg (GDD "Avatars and equipment"): a hog draped in a pale sheet — two
// ear bumps poke up, two dark eye holes, a scalloped hem, two stubby feet. Painted
// in its own off-white palette (never tinted), so it reads as a ghost on any tile.
// One frame, feet-anchored like every avatar.

const GHOST = {
  sheet: 0xf7f5ec,
  shade: 0xcfcfc9,
  out: 0x181818,
  eye: 0x1c140c,
  foot: 0x7a5b3c,
  face: 0xf2c99f,
} as const;

export function ghostDraw(p: PixelSink): void {
  const g = GHOST;
  groundShadow(p, 5.8, 1.8);
  blob(p, 5.8, 20, 1.1, 1, g.foot, g.out);
  blob(p, 9.4, 20, 1.1, 1, g.foot, g.out);
  blob(p, 7.5, 13, 5.8, 6.1, g.sheet, g.out);
  disc(p, 7.5, 8, 4.7, 3.8, g.sheet);
  // hidden Hog ears peeking through the sheet.
  blob(p, 4.5, 6.1, 1.3, 1.5, g.face, g.out);
  blob(p, 10.5, 6.1, 1.3, 1.5, g.face, g.out);
  disc(p, 4.5, 6.4, 0.7, 0.8, 0xd99d72);
  disc(p, 10.5, 6.4, 0.7, 0.8, 0xd99d72);
  // face windows, sheet folds, and side drapes.
  blob(p, 5.9, 10.4, 1.5, 2.2, g.face, g.out);
  blob(p, 9.3, 10.4, 1.5, 2.2, g.face, g.out);
  dot(p, 6, 10, g.eye); dot(p, 6, 9, g.eye); dot(p, 6, 9, 0xffffff);
  dot(p, 9.4, 10, g.eye); dot(p, 9.4, 9, g.eye); dot(p, 9.4, 9, 0xffffff);
  line(p, 7.2, 12.5, 8, 12.2, g.out);
  disc(p, 4, 15, 1.3, 3, g.shade);
  disc(p, 11, 15, 1.3, 3, g.shade);
  line(p, 3, 9, 2, 18, g.out);
  line(p, 12, 9, 13, 18, g.out);
  for (let x = 3; x <= 12; x += 3) {
    dot(p, x, 18, g.out);
    dot(p, x + 1, 19, g.shade);
  }
}
