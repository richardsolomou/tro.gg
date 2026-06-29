import { ARM_OVERLAY_ART, AVATAR_FRAME_ART, GHOST_ART, PIXEL_KEYS, type IndexedSpriteArt } from "./sprite_art";
import { compositeOver, outlinePass } from "./raster";

/**
 * Avatar sprite sheet metadata and renderer.
 *
 * The art itself lives in `sprite_art.ts` as indexed 16x24 pixel maps. This
 * module keeps the public sprite contract: style ids, frame names, sheet layout,
 * RGBA blending, and the paint functions used by both the PNG generator and the
 * browser runtime texture builder.
 */

export type Kind = "trogg" | "hog";
export type Facing = "down" | "up" | "left" | "right";
export type FrameName = "idle" | "walk_a" | "walk_b" | "run_a" | "run_b" | "attack_a" | "attack_b";

/**
 * Cosmetic body variants within a kind (GDD "Avatars and equipment"). A style
 * changes the silhouette features and base palette, but not the rig, anchor, or
 * animation frame layout. The first entry of each list is the default.
 */
export const TROGG_STYLES = ["moss", "stone", "ridge"] as const;
/** Every hog style painted into the sheet. The common three fill the random roaming
 *  crowd; the big two (buff, dino) are placed showpieces that span a 2x2 footprint
 *  and render at double size; the chicken is an easter egg, summoned, never random. */
export const HOG_STYLES = ["classic", "snow", "ember", "buff", "dino", "chicken"] as const;
/** The small hogs that fill the id-derived random crowd (see `hogStyleFor`). */
export const COMMON_HOG_STYLES = ["classic", "snow", "ember"] as const;
/** Hogs that occupy a 2x2 tile footprint and render at double size (GDD "Hogs"). */
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

/** Art pixels per frame. The frame is 32 wide so avatars render one tile wide
 *  at `tile / FRAME_W`, with extra height for 3/4-view head room. */
export const FRAME_W = 32;
export const FRAME_H = 48;

/** Feet anchor: where the sprite sits on its tile (bottom-centre). */
export const ANCHOR = { x: 16, y: 44 } as const;

export const KINDS: readonly Kind[] = ["trogg", "hog"] as const;
export const FACINGS: readonly Facing[] = ["down", "up", "left", "right"] as const;
export const FRAMES: readonly FrameName[] = ["idle", "walk_a", "walk_b", "run_a", "run_b", "attack_a", "attack_b"] as const;

/** Every (kind, style) row group in sheet order: a kind's styles, then the next
 *  kind's. Each group owns `FACINGS.length` rows. */
export function styleGroups(): { kind: Kind; style: string }[] {
  const out: { kind: Kind; style: string }[] = [];
  for (const kind of KINDS) for (const style of stylesOf(kind)) out.push({ kind, style });
  return out;
}

/** Sheet dimensions: columns = frames, rows = (kind x style) x facing. */
export const SHEET_COLS = FRAMES.length;
export const SHEET_ROWS = styleGroups().length * FACINGS.length;
export const SHEET_W = SHEET_COLS * FRAME_W;
export const SHEET_H = SHEET_ROWS * FRAME_H;

/** A pixel sink. `colour` is 0xRRGGBB; `alpha` is 0-255 (default opaque). The
 *  sink decides how to blend; this module only asks to place a pixel. */
export interface PixelSink {
  set(x: number, y: number, colour: number, alpha?: number): void;
}

/**
 * A `PixelSink` that source-over-blends into a flat RGBA byte array: a Node
 * `Uint8Array` for the sprite-sheet generator, or canvas `ImageData.data` for
 * the client texture builder. `data` must be `width * height * 4` bytes, zeroed
 * for a transparent start.
 */
export function rgbaSink(data: Uint8Array | Uint8ClampedArray, width: number, height: number): PixelSink {
  return {
    set(x, y, colour, alpha = 255) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      const sa = alpha / 255;
      const da = data[i + 3]! / 255;
      const oa = sa + da * (1 - sa);
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

/** Every frame rect, row-major: the full atlas. */
export function frames(): FrameRect[] {
  const out: FrameRect[] = [];
  for (const { kind, style } of styleGroups()) for (const facing of FACINGS) for (const frame of FRAMES) {
    out.push(frameRect(kind, style, facing, frame));
  }
  return out;
}

const PIXEL_KEY_INDEX: Record<string, number> = Object.fromEntries([...PIXEL_KEYS].map((key, i) => [key, i]));

/**
 * Blit one indexed art map at (ox, oy). Dimensions come from the art itself, so
 * it paints both 32×48 avatar frames and the smaller world-prop maps. Each key
 * indexes the art's local palette; `.` is transparent.
 */
export function blitArt(sink: PixelSink, art: IndexedSpriteArt, ox = 0, oy = 0): void {
  for (let y = 0; y < art.pixels.length; y++) {
    const row = art.pixels[y] ?? "";
    for (let x = 0; x < row.length; x++) {
      const key = row[x] ?? ".";
      if (key === ".") continue;
      const paletteIndex = PIXEL_KEY_INDEX[key];
      if (paletteIndex === undefined) throw new Error(`Unknown sprite pixel key: ${key}`);
      const rgba = art.palette[paletteIndex];
      if (rgba === undefined) throw new Error(`Missing sprite palette entry ${paletteIndex} for key ${key}`);
      const r = Math.floor(rgba / 0x1000000) & 0xff;
      const g = Math.floor(rgba / 0x10000) & 0xff;
      const b = Math.floor(rgba / 0x100) & 0xff;
      const a = rgba & 0xff;
      sink.set(ox + x, oy + y, r * 0x10000 + g * 0x100 + b, a);
    }
  }
}

/** A soft ground-contact shadow under a frame (matches the old baked shadow). */
function shadowEllipse(buf: Uint8Array, cx: number, cy: number, rx: number, ry: number, alpha: number): void {
  const sink = rgbaSink(buf, FRAME_W, FRAME_H);
  for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++)
    for (let x = Math.ceil(cx - rx); x <= Math.floor(cx + rx); x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) sink.set(x, y, 0x000000, alpha);
    }
}

/**
 * Compose one finished avatar frame from its un-outlined fill: run the single dilation outline
 * over the assembled fill (the GSC silhouette), then drop it onto the soft ground shadow. This
 * is where the unified outline happens at render time, so a stack of layers (body + armour +
 * hair) outlines as one — see the layered-avatar plan in the GDD.
 */
export function composeAvatarFrame(fill: IndexedSpriteArt, outline: number): Uint8Array {
  const layer = new Uint8Array(FRAME_W * FRAME_H * 4);
  blitArt(rgbaSink(layer, FRAME_W, FRAME_H), fill);
  outlinePass(layer, outline, FRAME_W, FRAME_H);
  const data = new Uint8Array(FRAME_W * FRAME_H * 4);
  shadowEllipse(data, 15.5, 43, 11, 3.2, 70);
  compositeOver(data, layer);
  return data;
}

/** Blit a raw RGBA frame buffer into a sink at (ox, oy). */
function blitBuffer(sink: PixelSink, buf: Uint8Array, ox: number, oy: number): void {
  for (let y = 0; y < FRAME_H; y++)
    for (let x = 0; x < FRAME_W; x++) {
      const i = (y * FRAME_W + x) * 4;
      const a = buf[i + 3]!;
      if (a === 0) continue;
      sink.set(ox + x, oy + y, buf[i]! * 0x10000 + buf[i + 1]! * 0x100 + buf[i + 2]!, a);
    }
}

/** Paint the whole avatar sheet: each frame is composed (fill → outline → shadow) into its
 *  cell, so the runtime texture and the committed PNG share the same composite-then-outline
 *  path. Frames without an `outline` (already-finished art) are blitted as-is. */
export function paintSheet(sink: PixelSink): void {
  for (const f of frames()) {
    const art = AVATAR_FRAME_ART[f.name]!;
    if (art.outline === undefined) blitArt(sink, art, f.x, f.y);
    else blitBuffer(sink, composeAvatarFrame(art, art.outline), f.x, f.y);
  }
}

/** Paint the standalone ghost sprite into one frame-sized surface. */
export function ghostDraw(sink: PixelSink): void {
  blitArt(sink, GHOST_ART, 0, 0);
}

/** Paint the near-arm overlays into a sheet matching the base layout (same `frameRect` cells),
 *  so the runtime can carve them by the same frame name and draw one over a held item. Frames
 *  with no overlay (facing up, non-trogg) leave their cell transparent. Already finished art —
 *  blitted, not composed. */
export function paintArmSheet(sink: PixelSink): void {
  for (const f of frames()) {
    const art = ARM_OVERLAY_ART[f.name];
    if (art) blitArt(sink, art, f.x, f.y);
  }
}

/** Whether a frame has a near-arm overlay (front facings of rig-driven creatures). */
export function hasArmOverlay(name: string): boolean {
  return ARM_OVERLAY_ART[name] !== undefined;
}
