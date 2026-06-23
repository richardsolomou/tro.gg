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
 * facing (down/up/left/right) and per animation frame (idle + a two-step walk).
 * The atlas is laid out as columns = frames, rows grouped by kind then facing, so
 * `frameRect` maps a `(kind, facing, frame)` to its cell. Frames are anchored at
 * the feet (`ANCHOR`) so a sprite drops onto a tile by its base, head room up.
 *
 * This is the avatar *base body* only. Held-item and armour overlays (GDD
 * per-hand layers) reuse the same frame grid and anchor when they land (M2+);
 * the rig reserves their order now. Nothing here is wired into rendering yet —
 * M0 still draws the placeholder marker (see `avatar.ts` / `world.ts`).
 */

export type Kind = "trogg" | "hog";
export type Facing = "down" | "up" | "left" | "right";
export type FrameName = "idle" | "walk_a" | "walk_b";

/** Art pixels per frame. 16 wide matches the tile (`ART` in terrain.ts); the
 *  extra height is 3/4-view head room above the feet anchor. */
export const FRAME_W = 16;
export const FRAME_H = 24;

/** Feet anchor: where the sprite sits on its tile (bottom-centre). */
export const ANCHOR = { x: 8, y: 22 } as const;

export const KINDS: readonly Kind[] = ["trogg", "hog"] as const;
export const FACINGS: readonly Facing[] = ["down", "up", "left", "right"] as const;
export const FRAMES: readonly FrameName[] = ["idle", "walk_a", "walk_b"] as const;

/** Sheet dimensions: columns = frames, rows = kind × facing. */
export const SHEET_COLS = FRAMES.length;
export const SHEET_ROWS = KINDS.length * FACINGS.length;
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
  facing: Facing;
  frame: FrameName;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Stable frame key used in the atlas, e.g. `trogg_down_walk_a`. */
export function frameName(kind: Kind, facing: Facing, frame: FrameName): string {
  return `${kind}_${facing}_${frame}`;
}

/** Where a given frame lives in the sheet. Row = kind block + facing offset. */
export function frameRect(kind: Kind, facing: Facing, frame: FrameName): FrameRect {
  const row = KINDS.indexOf(kind) * FACINGS.length + FACINGS.indexOf(facing);
  const col = FRAMES.indexOf(frame);
  return {
    name: frameName(kind, facing, frame),
    kind,
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
  for (const kind of KINDS) for (const facing of FACINGS) for (const frame of FRAMES) {
    out.push(frameRect(kind, facing, frame));
  }
  return out;
}

/** Paint the whole sheet by drawing each frame into its cell. */
export function paintSheet(sink: PixelSink): void {
  for (const f of frames()) paintFrame(sink, f.kind, f.facing, f.frame, f.x, f.y);
}

// ── palettes ────────────────────────────────────────────────────────────────
// Earthy, torch-lit tones that sit with the cave terrain palette (terrain.ts).

const SHADOW = 0x000000;

const TROGG = {
  out: 0x241a10, // dark outline
  body: 0x7e8c52, // mossy hide
  light: 0x97a566,
  shade: 0x5c673a,
  belly: 0xb8c184,
  eye: 0xffd34e, // glowing amber (shared with the world palette)
  pupil: 0x1c140c,
  mouth: 0x39271a,
} as const;

const HOG = {
  out: 0x2a1d10,
  quill: 0x6e5334,
  quillLt: 0x916f44,
  quillDk: 0x40301c,
  face: 0xe3cf9f, // warm cream snout/belly
  faceLt: 0xf2e4c2,
  faceDk: 0xc8a86e,
  nose: 0x241710,
  eye: 0x1c140c,
  glint: 0xece0c6,
} as const;

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

/** Vertical foot offset for a walk frame; left/right feet alternate lifting. */
function footLift(frame: FrameName, left: boolean): number {
  if (frame === "walk_a") return left ? -1 : 0;
  if (frame === "walk_b") return left ? 0 : -1;
  return 0;
}

/** A 1px body bob on the walk frames, so the whole avatar lifts as it strides. */
function bodyBob(frame: FrameName): number {
  return frame === "idle" ? 0 : -1;
}

// ── frame dispatch ───────────────────────────────────────────────────────────

function paintFrame(sink: PixelSink, kind: Kind, facing: Facing, frame: FrameName, ox: number, oy: number): void {
  const flip = facing === "left";
  const p = cell(sink, ox, oy, flip);
  const draw = kind === "trogg" ? troggDraw : hogDraw;
  // left is the mirror of right, so author both profiles as "side".
  const view = facing === "left" || facing === "right" ? "side" : facing;
  draw(p, view, frame);
}

type View = "down" | "up" | "side";
type Draw = (p: PixelSink, view: View, frame: FrameName) => void;

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
// A small, big-headed cave-dweller: round mossy body, oversized glowing eyes.

const troggDraw: Draw = (p, view, frame) => {
  const c = TROGG;
  const b = bodyBob(frame);
  groundShadow(p);
  feet(p, frame, c.shade, c.out, 20, 5.5, 9.5);

  // torso
  blob(p, 7.5, 15 + b, 4, 3.6, c.body, c.out);
  disc(p, 7.5, 16 + b, 2.4, 2.6, c.belly);

  if (view === "side") {
    // arm swings forward (to the right) on alternating walk frames
    const swing = frame === "walk_a" ? 1 : frame === "walk_b" ? -1 : 0;
    blob(p, 10, 14 + b + swing, 1.4, 2, c.shade, c.out);
    // head, nudged toward the facing direction
    blob(p, 8.5, 8 + b, 5, 4.4, c.body, c.out);
    disc(p, 6, 6 + b, 2.6, 2.6, c.light); // lit crown
    blob(p, 2.5, 7 + b, 1.3, 2, c.body, c.out); // trailing ear
    // brow + single eye looking right
    dot(p, 11, 8 + b, c.eye); dot(p, 12, 8 + b, c.eye); dot(p, 11, 9 + b, c.eye);
    dot(p, 12, 8 + b, c.pupil);
    rect(p, 12, 11 + b, 2, 1, c.mouth); // snout/mouth tip
    return;
  }

  if (view === "up") {
    // back of the head: no face, lit crown, two ear nubs, a little spine tuft
    blob(p, 7.5, 8 + b, 5.4, 4.6, c.body, c.out);
    disc(p, 7.5, 6 + b, 3.4, 2.4, c.light);
    blob(p, 2.6, 7 + b, 1.3, 2, c.body, c.out);
    blob(p, 12.4, 7 + b, 1.3, 2, c.body, c.out);
    rect(p, 7, 11 + b, 1, 3, c.shade); // nape/spine
    return;
  }

  // down: face the camera, big amber eyes
  blob(p, 7.5, 8 + b, 5.6, 4.8, c.body, c.out);
  blob(p, 2.6, 7 + b, 1.3, 2, c.body, c.out); // ears
  blob(p, 12.4, 7 + b, 1.3, 2, c.body, c.out);
  disc(p, 7.5, 5.5 + b, 3.4, 1.8, c.light); // lit brow
  // eyes
  for (const ex of [5, 10]) {
    disc(p, ex, 8 + b, 1.7, 1.9, c.eye);
    dot(p, ex + (ex === 5 ? 0.3 : -0.3), 8 + b, c.pupil);
    dot(p, ex, 8.6 + b, c.pupil);
  }
  // nostrils + mouth
  dot(p, 7, 10.5 + b, c.mouth); dot(p, 8, 10.5 + b, c.mouth);
  rect(p, 6, 12 + b, 4, 1, c.mouth);
};

// ── hog ──────────────────────────────────────────────────────────────────────
// A friendly hedgehog: cream snout and belly, a spiky quill dome over the back.

/** Quills: a dome of base colour, mottled light/dark, with a spiky silhouette. */
function quillDome(p: PixelSink, cx: number, cy: number, rx: number, ry: number): void {
  const h = HOG;
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

const hogDraw: Draw = (p, view, frame) => {
  const h = HOG;
  const b = bodyBob(frame);
  groundShadow(p);
  feet(p, frame, h.faceDk, h.out, 20, 5.5, 9.5);

  if (view === "side") {
    // belly/snout in front (right), quills doming over the back (left)
    blob(p, 8, 15 + b, 4.4, 3.4, h.face, h.out);
    quillDome(p, 6, 12 + b, 4.6, 4.2);
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
    quillDome(p, 7.5, 12 + b, 6, 5.4);
    disc(p, 7.5, 9 + b, 2.4, 1.6, h.quillDk); // crown shade
    return;
  }

  // down: round cream face under a quill hood, beady eyes, button nose
  quillDome(p, 7.5, 9 + b, 6.2, 5);
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
