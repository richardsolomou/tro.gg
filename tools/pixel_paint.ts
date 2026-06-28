/**
 * Shared GSC-style pixel-paint helpers for the art generators
 * (`gen-sprite-art.ts`, `gen-item-art.ts`).
 *
 * Art direction is Pokémon Gold/Silver: flat shapes in a tight palette, then a
 * single dilation pass tracing a crisp dark outline around the whole silhouette.
 * Each frame is painted into its own RGBA layer with no outline; `outlinePass`
 * adds the border, then the layer is composited over a soft ground shadow and
 * `quantize` turns it into an indexed palette + key map.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import type { PixelSink } from "../shared/sprites.ts";

// Silhouette outline + compositing live in shared so the client runtime can run the same
// outline over a composited layer stack (composite-then-outline avatars, GDD).
export { compositeOver, opaque, outlinePass } from "../shared/raster.ts";

/** Indexing alphabet for the emitted maps. Kept in sync with the generated files. */
export const PIXEL_KEYS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-/:;<=>?@[]^_{|}~";

export interface IndexedArt {
  palette: number[];
  pixels: string[];
}

// ── primitives ────────────────────────────────────────────────────────────────
// Colours are 0xRRGGBB, painted flat (opaque) — no alpha gradients, to keep the
// GSC look and palettes tiny.

export function dot(p: PixelSink, x: number, y: number, colour: number): void {
  p.set(Math.round(x), Math.round(y), colour);
}

export function rect(p: PixelSink, x: number, y: number, w: number, h: number, colour: number): void {
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) p.set(Math.round(x) + xx, Math.round(y) + yy, colour);
}

export function line(p: PixelSink, x1: number, y1: number, x2: number, y2: number, colour: number): void {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const steps = Math.max(dx, dy, 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    dot(p, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, colour);
  }
}

/** Filled ellipse centred at (cx, cy) with radii (rx, ry). Centres may be fractional. */
export function disc(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number): void {
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) p.set(x, y, colour);
    }
  }
}

/**
 * A two-tone filled ellipse, the GSC shading staple: the whole shape in `shade`,
 * then the same shape nudged up-and-left in `base`, leaving a flat shadow
 * crescent along the bottom-right.
 */
export function shaded(p: PixelSink, cx: number, cy: number, rx: number, ry: number, base: number, shade: number): void {
  disc(p, cx, cy, rx, ry, shade);
  disc(p, cx - 1, cy - 1, rx - 0.7, ry - 0.7, base);
}

// ── outline, composite, quantise ────────────────────────────────────────────────

/** True where the layer pixel is painted (any alpha). */
/** Turn a painted RGBA buffer into an indexed palette + key-map of size w×h. */
export function quantize(data: Uint8Array, w: number, h: number): IndexedArt {
  const palette: number[] = [];
  const index = new Map<number, number>();
  const pixels: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
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

/** Render one indexed-art literal for the generated source files. */
export function fmtArt(art: IndexedArt, indent: string): string {
  const pal = art.palette.map((n) => "0x" + (n >>> 0).toString(16).padStart(8, "0")).join(", ");
  const rows = art.pixels.map((r) => `${indent}  ${JSON.stringify(r)}`).join(",\n");
  return `{ palette: [${pal}], pixels: [\n${rows}\n${indent}] }`;
}
