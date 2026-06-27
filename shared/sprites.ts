/**
 * Programmer pixel art for the trogg and Hog avatars (GDD "Avatars and
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
  // Mossy hide, amber eyes, soft ear nubs — the original cave-dweller.
  moss: { out: 0x241a10, body: 0x7e8c52, light: 0x97a566, shade: 0x5c673a, belly: 0xb8c184, eye: 0xffd34e, pupil: 0x1c140c, mouth: 0x39271a, crest: "ears" },
  // Grey stone golem, red eyes, an earless crag — the brute out of the deep dark.
  stone: { out: 0x1d2026, body: 0x868d96, light: 0xa7adb5, shade: 0x5b616b, belly: 0xb4b9c0, eye: 0xff5240, pupil: 0x2a0d08, mouth: 0x2b2f37, crest: "none" },
  // Dark bog-brown, amber eyes, a pair of stubby horns — the ridge-back.
  ridge: { out: 0x16110a, body: 0x6f5d3a, light: 0x8a7548, shade: 0x4c3f27, belly: 0x9d8a5c, eye: 0xffd34e, pupil: 0x1c140c, mouth: 0x2a2013, crest: "horns" },
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
function groundShadow(p: PixelSink): void {
  disc(p, 7.5, 21, 5, 1.6, SHADOW, 70);
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
    if (view !== "side") { dot(p, 3, 6 + hb, c.shade); dot(p, 12, 6 + hb, c.shade); }
    return;
  }
  const horns = c.crest === "horns";
  const fill = horns ? c.light : c.body;
  const ry = horns ? 1.7 : 2;
  if (view === "side") {
    blob(p, 2.5 + lean, 7 + hb, 1.3, ry, fill, c.out);
    if (horns) dot(p, 2.5 + lean, 4 + hb, c.out); // a tip
    return;
  }
  const lx = horns ? 3.4 : 2.6;
  const rx = horns ? 11.6 : 12.4;
  blob(p, lx, 7 + hb, 1.3, ry, fill, c.out);
  blob(p, rx, 7 + hb, 1.3, ry, fill, c.out);
  if (horns) { dot(p, lx, 4 + hb, c.out); dot(p, rx, 4 + hb, c.out); }
}

const troggDraw = (p: PixelSink, view: View, frame: FrameName, c: TroggSkin): void => {
  const b = bodyBob(frame);
  const run = isRun(frame);
  // Running hunch: the head dips toward the body (crouch) on every facing, and the
  // side profile also pitches forward into the run (lean, mirrored with the sprite).
  const crouch = run ? 1 : 0;
  const hb = b + crouch; // head bob — head region only, so it ducks below the torso
  const lean = view === "side" && run ? RUN_LEAN : 0;
  groundShadow(p);
  // Stance widens a touch when running.
  feet(p, frame, c.shade, c.out, 20, run ? 5 : 5.5, run ? 10 : 9.5);

  // torso
  blob(p, 7.5, 15 + b, 4, 3.6, c.body, c.out);
  disc(p, 7.5, 16 + b, 2.4, 2.6, c.belly);

  if (view === "side") {
    // arm swings forward (to the right), further on a run than a walk
    const swing = stride(frame) * (run ? 2 : 1);
    blob(p, 10 + lean, 14 + b + swing, 1.4, 2, c.shade, c.out);
    // head, nudged toward the facing direction (and forward when running)
    blob(p, 8.5 + lean, 8 + hb, 5, 4.4, c.body, c.out);
    disc(p, 6 + lean, 6 + hb, 2.6, 2.6, c.light); // lit crown
    troggCrest(p, c, "side", hb, lean); // trailing crest
    // brow + single eye looking right
    dot(p, 11 + lean, 8 + hb, c.eye); dot(p, 12 + lean, 8 + hb, c.eye); dot(p, 11 + lean, 9 + hb, c.eye);
    dot(p, 12 + lean, 8 + hb, c.pupil);
    rect(p, 12 + lean, 11 + hb, 2, 1, c.mouth); // snout/mouth tip
    return;
  }

  if (view === "up") {
    // back of the head: no face, lit crown, the crest, a little spine tuft
    blob(p, 7.5, 8 + hb, 5.4, 4.6, c.body, c.out);
    disc(p, 7.5, 6 + hb, 3.4, 2.4, c.light);
    troggCrest(p, c, "up", hb, 0);
    rect(p, 7, 11 + hb, 1, 3, c.shade); // nape/spine
    return;
  }

  // down: face the camera, big glowing eyes
  blob(p, 7.5, 8 + hb, 5.6, 4.8, c.body, c.out);
  troggCrest(p, c, "down", hb, 0);
  disc(p, 7.5, 5.5 + hb, 3.4, 1.8, c.light); // lit brow
  // eyes
  for (const ex of [5, 10]) {
    disc(p, ex, 8 + hb, 1.7, 1.9, c.eye);
    dot(p, ex + (ex === 5 ? 0.3 : -0.3), 8 + hb, c.pupil);
    dot(p, ex, 8.6 + hb, c.pupil);
  }
  // nostrils + mouth
  dot(p, 7, 10.5 + hb, c.mouth); dot(p, 8, 10.5 + hb, c.mouth);
  rect(p, 6, 12 + hb, 4, 1, c.mouth);
};

// ── hog ──────────────────────────────────────────────────────────────────────
// A friendly hedgehog: cream snout and belly, a spiky quill dome over the back.

/** Quills: a dome of base colour, mottled light/dark, with a spiky silhouette. */
function quillDome(p: PixelSink, cx: number, cy: number, rx: number, ry: number, h: HogSkin): void {
  blob(p, cx, cy, rx, ry, h.quill, h.out);
  // deterministic mottling — a fixed lattice so the texture is identical
  // everywhere (same intent as terrain's seeded rng, but no state needed).
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      const k = (x * 3 + y * 5) % 4;
      if (k === 0) dot(p, x, y, h.quillLt);
      else if (k === 2) dot(p, x, y, h.quillDk);
    }
  }
  // spikes poking out along the top arc
  for (let x = Math.ceil(cx - rx + 1); x <= Math.floor(cx + rx - 1); x += 2) {
    const nx = (x - cx) / rx;
    const top = cy - ry * Math.sqrt(Math.max(0, 1 - nx * nx));
    dot(p, x, top - 1, x % 4 === 0 ? h.quillLt : h.quillDk);
  }
}

const hogDraw = (p: PixelSink, view: View, frame: FrameName, h: HogSkin): void => {
  const b = bodyBob(frame);
  groundShadow(p);
  feet(p, frame, h.faceDk, h.out, 20, 5.5, 9.5);

  if (view === "side") {
    // belly/snout in front (right), quills doming over the back (left)
    blob(p, 8, 15 + b, 4.4, 3.4, h.face, h.out);
    quillDome(p, 6, 12 + b, 4.6, 4.2, h);
    // pointed snout to the right
    blob(p, 12, 14 + b, 2, 1.8, h.faceLt, h.out);
    dot(p, 13, 14 + b, h.nose); dot(p, 14, 14 + b, h.nose);
    // eye
    dot(p, 10, 12 + b, h.eye); dot(p, 10, 11 + b, h.eye);
    dot(p, 10, 11 + b, h.glint);
    return;
  }

  if (view === "up") {
    // walking away: almost all quills, a sliver of feet below
    quillDome(p, 7.5, 12 + b, 6, 5.4, h);
    disc(p, 7.5, 9 + b, 2.4, 1.6, h.quillDk); // crown shade
    return;
  }

  // down: round cream face under a quill hood, beady eyes, button nose
  quillDome(p, 7.5, 9 + b, 6.2, 5, h);
  blob(p, 7.5, 15 + b, 4.6, 3.4, h.face, h.out); // belly
  disc(p, 7.5, 13.5 + b, 3.6, 2.8, h.faceLt); // face
  // eyes
  for (const ex of [5.5, 9.5]) {
    dot(p, ex, 13 + b, h.eye);
    dot(p, ex, 12 + b, h.eye);
    dot(p, ex, 12 + b, h.glint);
  }
  // snout + nose
  blob(p, 7.5, 16 + b, 1.8, 1.6, h.faceLt, h.out);
  dot(p, 7, 16 + b, h.nose); dot(p, 8, 16 + b, h.nose);
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
  groundShadow(p);
  feet(p, frame, c.skinDk, c.out, 20, 5.5, 9.5);
  // thick thighs
  blob(p, 6, 17 + b, 1.7, 2, c.skin, c.out);
  blob(p, 9, 17 + b, 1.7, 2, c.skin, c.out);

  if (view === "up") {
    // broad back: lats taper to the waist, quill ridge down the spine, raised arms
    blob(p, 7.5, 12 + b, 5.4, 4, c.skin, c.out);
    rect(p, 7, 9 + b, 2, 5, c.skinDk);
    blob(p, 2.6, 8 + b, 1.7, 2.4, c.skin, c.out); // raised arms
    blob(p, 12.4, 8 + b, 1.7, 2.4, c.skin, c.out);
    quillDome(p, 7.5, 7 + b, 2.4, 1.8, HOG_SKINS.classic!);
    return;
  }

  const side = view === "side";
  // barrel chest + pecs
  blob(p, 7.5, 13 + b, side ? 4.6 : 5.2, 3.8, c.skin, c.out);
  disc(p, 5.6, 12 + b, 1.7, 1.5, c.skinLt);
  disc(p, 9.4, 12 + b, 1.7, 1.5, c.skinLt);
  dot(p, 7.5, 14 + b, c.skinDk); dot(p, 7.5, 15 + b, c.skinDk); // ab seam

  // raised arms, fists up by the head — the flex
  for (const s of [-1, 1]) {
    const sx = 7.5 + s * 4;
    blob(p, sx, 10 + b, 1.9, 2.1, c.skin, c.out); // bicep ball
    blob(p, sx - s * 1.2, 7.5 + b, 1.3, 1.6, c.skinLt, c.out); // forearm/fist toward head
  }

  // small head with quill hair + hedgehog face between the arms
  quillDome(p, 7.5, 5.5 + b, 2.7, 2.1, HOG_SKINS.classic!);
  disc(p, 7.5, 7.5 + b, 2.1, 1.8, c.face);
  dot(p, 6.6, 7.4 + b, c.eye); dot(p, 8.4, 7.4 + b, c.eye);
  dot(p, 7.5, 8.4 + b, c.out); // determined mouth
};

// ── dino hog ────────────────────────────────────────────────────────────────────
// A hedgehog in a T-rex costume — green body, toothy hood, the hog face in the maw
// (GDD "Hogs": big showpiece, 2×2). Like buff, authored at 16×24 and rendered double.

const DINO = {
  out: 0x223315,
  body: 0x6fa84a,
  bodyLt: 0x8cc25e,
  bodyDk: 0x4e7d33,
  belly: 0xb6d188,
  face: 0xf2e4c2,
  tooth: 0xf3eedf,
  eye: 0x1c140c,
} as const;

/** Sawtooth dino ridge along an arc — the costume's spiky back. */
function dinoRidge(p: PixelSink, cx: number, top: number, span: number, dk: number): void {
  for (let x = cx - span; x <= cx + span; x += 2) dot(p, x, top - 1, dk);
}

const dinoDraw = (p: PixelSink, view: View, frame: FrameName): void => {
  const c = DINO;
  const b = bodyBob(frame);
  groundShadow(p);
  feet(p, frame, c.bodyDk, c.out, 20, 5, 10);

  if (view === "up") {
    blob(p, 7.5, 13 + b, 5.4, 4.4, c.body, c.out);
    rect(p, 7, 9 + b, 2, 6, c.bodyDk); // spine
    dinoRidge(p, 7.5, 9 + b, 4, c.bodyDk);
    blob(p, 2.4, 16 + b, 1.6, 1.2, c.bodyDk, c.out); // tail stub
    return;
  }

  if (view === "side") {
    // tail left, big jaw right, the classic T-rex profile
    blob(p, 2.4, 15 + b, 2.4, 1.4, c.body, c.out); // tail
    blob(p, 7.5, 13 + b, 4.4, 3.8, c.body, c.out); // body
    disc(p, 8, 14.5 + b, 2.6, 2.2, c.belly);
    blob(p, 4, 12 + b, 1, 1.4, c.bodyDk, c.out); // little arm
    dinoRidge(p, 6.5, 9 + b, 3, c.bodyDk);
    // head + open jaw to the right
    blob(p, 11.5, 11 + b, 2.8, 2.4, c.body, c.out);
    rect(p, 10, 11 + b, 5, 1, c.out); // mouth gap
    for (let x = 10; x <= 14; x += 2) { dot(p, x, 10 + b, c.tooth); dot(p, x + 1, 12 + b, c.tooth); }
    disc(p, 11.5, 11.6 + b, 1.1, 1, c.face); // hog face in the maw
    dot(p, 12, 11.4 + b, c.eye);
    dot(p, 12.6, 8.6 + b, c.eye); // dino eye on the snout
    return;
  }

  // down: facing camera — toothy green hood, hog face peeking from the jaw
  blob(p, 7.5, 14 + b, 5.4, 4.2, c.body, c.out);
  disc(p, 7.5, 15 + b, 3, 2.6, c.belly);
  blob(p, 3.4, 13 + b, 1, 1.4, c.bodyDk, c.out); // arms
  blob(p, 11.6, 13 + b, 1, 1.4, c.bodyDk, c.out);
  // hood + eyes up top
  blob(p, 7.5, 8 + b, 4.2, 3.2, c.body, c.out);
  dinoRidge(p, 7.5, 5.5 + b, 3, c.bodyDk);
  dot(p, 5.6, 6.6 + b, c.eye); dot(p, 9.4, 6.6 + b, c.eye);
  // open mouth with teeth, hog face inside
  rect(p, 5, 9 + b, 6, 1, c.out);
  for (let x = 5; x <= 10; x += 2) dot(p, x, 8 + b, c.tooth);
  disc(p, 7.5, 10.5 + b, 2, 1.7, c.face);
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
  comb: 0xc0392b,
  beak: 0xe08a2b,
  face: 0xf2e4c2,
  eye: 0x1c140c,
} as const;

const chickenDraw = (p: PixelSink, view: View, frame: FrameName): void => {
  const c = CHICK;
  const b = bodyBob(frame);
  groundShadow(p);
  // orange feet
  blob(p, 6.5, 20, 1, 0.9, c.beak, c.out);
  blob(p, 9, 20, 1, 0.9, c.beak, c.out);

  if (view === "up") {
    blob(p, 7.5, 13 + b, 5, 4.4, c.body, c.out);
    blob(p, 4, 17 + b, 1.6, 1.4, c.comb, c.out); // tail feathers
    dot(p, 7, 5 + b, c.comb); dot(p, 7.5, 4.5 + b, c.comb); dot(p, 8, 5 + b, c.comb);
    return;
  }

  // plump round body + stubby wings
  blob(p, 7.5, 14 + b, 5, 4.2, c.body, c.out);
  disc(p, 7.5, 15 + b, 3, 2.6, c.bodyDk);
  blob(p, 3.4, 13.5 + b, 1.3, 1.8, c.body, c.out);
  blob(p, 11.6, 13.5 + b, 1.3, 1.8, c.body, c.out);
  // red tail feathers (one side)
  blob(p, 3, 12 + b, 1.2, 1.4, c.comb, c.out);
  // comb on top
  dot(p, 6.6, 5 + b, c.comb); dot(p, 7.5, 4.4 + b, c.comb); dot(p, 8.4, 5 + b, c.comb);
  // hog face under a beak
  disc(p, 7.5, 9.5 + b, 2.3, 2, c.face);
  dot(p, 6.5, 9.3 + b, c.eye); dot(p, 8.5, 9.3 + b, c.eye);
  rect(p, 7, 10.6 + b, 2, 1, c.beak); // beak
  if (view === "side") dot(p, 10, 9.3 + b, c.eye); // profile eye nudge
};

// ── ghost ──────────────────────────────────────────────────────────────────────
// The cosmetic ghost easter egg (GDD "Avatars and equipment"): a hog draped in a pale sheet — two
// ear bumps poke up, two dark eye holes, a scalloped hem, two stubby feet. Painted
// in its own off-white palette (never tinted), so it reads as a ghost on any tile.
// One frame, feet-anchored like every avatar.

const GHOST = {
  sheet: 0xf3efe6,
  shade: 0xd7d2c5,
  out: 0x2a2620,
  eye: 0x1c140c,
  foot: 0x7a5b3c,
} as const;

export function ghostDraw(p: PixelSink): void {
  const g = GHOST;
  groundShadow(p);
  // stubby feet peeking under the hem
  blob(p, 6, 20, 1.1, 1, g.foot, g.out);
  blob(p, 9.5, 20, 1.1, 1, g.foot, g.out);
  // draped body + crown, with two ear bumps
  blob(p, 7.5, 13, 5.6, 6.2, g.sheet, g.out);
  disc(p, 7.5, 8, 4.4, 3.4, g.sheet);
  blob(p, 5, 5.5, 1.7, 1.9, g.sheet, g.out);
  blob(p, 10, 5.5, 1.7, 1.9, g.sheet, g.out);
  // shaded underfolds either side
  disc(p, 4.4, 15, 1.5, 2.3, g.shade);
  disc(p, 10.6, 15, 1.5, 2.3, g.shade);
  // scalloped hem
  for (let x = 3; x <= 12; x += 3) { dot(p, x, 18, g.out); dot(p, x, 19, g.shade); }
  // eye holes
  disc(p, 6, 11, 1, 1.5, g.eye);
  disc(p, 9.5, 11, 1, 1.5, g.eye);
}
