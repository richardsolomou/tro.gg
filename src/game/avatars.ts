import Phaser from "phaser";
import { frameName, frames, paintSheet, rgbaSink, SHEET_H, SHEET_W, type Facing, type FrameName, type Kind, type PixelSink } from "@trogg/shared";

/**
 * Client-side avatar textures. The trogg/Hog art is defined once in
 * `shared/sprites.ts` as pure paint logic; here we paint the whole sheet into a
 * canvas once and register it with Phaser's texture manager, carving a named
 * sub-frame per `(kind, facing, frame)`. Sprites then reference frames by key —
 * the same runtime-painted-texture approach as `terrain.ts`, so the client
 * carries no image asset to load (the committed PNG is the reviewable export,
 * not a runtime dependency).
 */

/** Texture keys: the tinted base sheet and the flat-white ghost silhouette. */
export const AVATAR_TEX = "avatars";
export const GHOST_TEX = "avatars-ghost";

/** Paint a full sprite sheet into an offscreen canvas. `paint` drives the pixels. */
function paintCanvas(paint: (sink: PixelSink) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SHEET_W, SHEET_H);
  paint(rgbaSink(img.data, SHEET_W, SHEET_H));
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Register a painted sheet on the texture manager and carve every frame from it. */
function registerSheet(scene: Phaser.Scene, key: string, paint: (sink: PixelSink) => void): void {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.addCanvas(key, paintCanvas(paint));
  if (!tex) return;
  for (const f of frames()) tex.add(f.name, 0, f.x, f.y, f.w, f.h);
}

/**
 * Register both avatar sheets on the scene's texture manager: the tinted base
 * sheet, and a flat-white silhouette (every pixel forced white, each keeping its
 * own alpha) for the ghost easter egg — white in the texture, so it needs no
 * tint. Idempotent, so it's safe to call on every scene create.
 */
export function registerAvatarTextures(scene: Phaser.Scene): void {
  registerSheet(scene, AVATAR_TEX, paintSheet);
  registerSheet(scene, GHOST_TEX, (sink) => paintSheet({ set: (x, y, _colour, alpha) => sink.set(x, y, 0xffffff, alpha) }));
}

/** The frame key for one avatar frame within `AVATAR_TEX` / `GHOST_TEX`. */
export function avatarFrameName(kind: Kind, facing: Facing, frame: FrameName): string {
  return frameName(kind, facing, frame);
}

/**
 * The facing a movement intent reads as. WASD/path motion sets `(dirX, dirY)`;
 * the dominant axis wins so a diagonal still picks a cardinal sprite. Idle
 * (0, 0) keeps the last facing — a stopped trogg shouldn't snap to a default.
 */
export function facingFromDir(dirX: number, dirY: number, last: Facing): Facing {
  if (dirX === 0 && dirY === 0) return last;
  if (Math.abs(dirX) >= Math.abs(dirY)) return dirX < 0 ? "left" : "right";
  return dirY < 0 ? "up" : "down";
}

/** Milliseconds per step of the two-frame stride cycle — quicker when running. */
const WALK_STEP_MS = 160;
const RUN_STEP_MS = 100;

/** The frame to show: idle when stopped, else an alternating two-step stride —
 *  the walk cycle, or the faster hunched run cycle when `running` (GDD "Movement"). */
export function avatarFrame(moving: boolean, running: boolean, nowMs: number): FrameName {
  if (!moving) return "idle";
  const even = Math.floor(nowMs / (running ? RUN_STEP_MS : WALK_STEP_MS)) % 2 === 0;
  if (running) return even ? "run_a" : "run_b";
  return even ? "walk_a" : "walk_b";
}
