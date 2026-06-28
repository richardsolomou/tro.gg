import Phaser from "phaser";
import { blitArt, ITEM_ART, ITEM_ART_H, ITEM_ART_W, rgbaSink, type PixelSink } from "@trogg/shared";

/**
 * Client-side world-prop textures: the tools, the stone resource, and the
 * boulder. Like the avatars (`avatars.ts`), the art is defined once in
 * `shared/item_art.ts` as indexed pixel maps and painted into one canvas texture
 * at runtime, carved into a named frame per prop — so the client carries no
 * image asset to load and the committed art stays the single source of truth.
 */

export const ITEM_TEX = "items";

/** Atlas column order; each prop's frame is keyed by its name. */
const ITEM_NAMES = Object.keys(ITEM_ART);

function paintCanvas(w: number, h: number, paint: (sink: PixelSink) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  paint(rgbaSink(img.data, w, h));
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Register the prop atlas on the texture manager and carve a frame per prop. Idempotent. */
export function registerItemTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists(ITEM_TEX)) return;
  const canvas = paintCanvas(ITEM_NAMES.length * ITEM_ART_W, ITEM_ART_H, (sink) => {
    ITEM_NAMES.forEach((name, i) => blitArt(sink, ITEM_ART[name]!, i * ITEM_ART_W, 0));
  });
  const tex = scene.textures.addCanvas(ITEM_TEX, canvas);
  if (!tex) return;
  ITEM_NAMES.forEach((name, i) => tex.add(name, 0, i * ITEM_ART_W, 0, ITEM_ART_W, ITEM_ART_H));
}

/** Whether a prop has a sprite in the atlas (tools, stone, boulder). */
export function hasItemArt(name: string): boolean {
  return name in ITEM_ART;
}
