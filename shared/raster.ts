/**
 * Flat-RGBA raster ops shared by the art generator (Node `Uint8Array`) and the client
 * runtime (canvas `Uint8ClampedArray`): silhouette outline and source-over compositing,
 * with no DOM or Node dependency. These are the keystone for composite-then-outline
 * layered avatars (GDD "Layered avatars"): the runtime stacks a creature's equipped
 * layers, then runs one `outlinePass` over the assembled silhouette for the unified
 * Gold/Silver border — the same outline the generator bakes today.
 */

/** A flat RGBA pixel buffer: `width * height * 4` bytes, row-major, source-over semantics. */
export type RgbaBuffer = Uint8Array | Uint8ClampedArray;

/** Whether the pixel at (x, y) is painted (non-zero alpha); out-of-bounds is transparent. */
export function opaque(layer: RgbaBuffer, x: number, y: number, w: number, h: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  return layer[(y * w + x) * 4 + 3]! > 0;
}

/** Dilate a 1px outline in `colour` into every transparent pixel that touches a painted one —
 *  the clean GSC border around the whole silhouette. */
export function outlinePass(layer: RgbaBuffer, colour: number, w: number, h: number): void {
  const r = (colour >> 16) & 0xff;
  const g = (colour >> 8) & 0xff;
  const bl = colour & 0xff;
  const targets: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (layer[i + 3]! > 0) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && opaque(layer, x + dx, y + dy, w, h)) { near = true; break; }
      }
      if (near) targets.push(i);
    }
  }
  for (const i of targets) { layer[i] = r; layer[i + 1] = g; layer[i + 2] = bl; layer[i + 3] = 255; }
}

/** Source-over composite `src` onto `dst` (same dimensions, RGBA). */
export function compositeOver(dst: RgbaBuffer, src: RgbaBuffer): void {
  for (let i = 0; i < dst.length; i += 4) {
    const sa = src[i + 3]! / 255;
    if (sa === 0) continue;
    const da = dst[i + 3]! / 255;
    const oa = sa + da * (1 - sa);
    const blend = (s: number, d: number) => Math.round((s * sa + d * da * (1 - sa)) / oa);
    dst[i] = blend(src[i]!, dst[i]!);
    dst[i + 1] = blend(src[i + 1]!, dst[i + 1]!);
    dst[i + 2] = blend(src[i + 2]!, dst[i + 2]!);
    dst[i + 3] = Math.round(oa * 255);
  }
}
