import Phaser from "phaser";
import { FRAME_H, FRAME_W, frameName, frames, ghostDraw, paintSheet, rgbaSink, SHEET_H, SHEET_W, type Facing, type FrameName, type Kind, type PixelSink } from "@trogg/shared";
import { STRIKE_PEAK } from "./equipment.js";

/**
 * Client-side avatar textures. The trogg/Hog art is defined once in
 * `shared/sprites.ts` as pure paint logic; here we paint the whole sheet into a
 * canvas once and register it with Phaser's texture manager, carving a named
 * sub-frame per `(kind, facing, frame)`. Sprites then reference frames by key —
 * the same runtime-painted-texture approach as `terrain.ts`, so the client
 * carries no image asset to load (the committed PNG is the reviewable export,
 * not a runtime dependency).
 */

/** Texture keys: the multi-style base sheet and the standalone ghost sprite. */
export const AVATAR_TEX = "avatars";
export const GHOST_TEX = "avatars-ghost";
/** The single frame carved from `GHOST_TEX` (the ghost is one drawing, not a sheet). */
export const GHOST_FRAME = "ghost";

/** Paint into an offscreen canvas of the given size. `paint` drives the pixels. */
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

/** Register the painted base sheet on the texture manager and carve every frame from it. */
function registerSheet(scene: Phaser.Scene): void {
  if (scene.textures.exists(AVATAR_TEX)) return;
  const tex = scene.textures.addCanvas(AVATAR_TEX, paintCanvas(SHEET_W, SHEET_H, paintSheet));
  if (!tex) return;
  for (const f of frames()) tex.add(f.name, 0, f.x, f.y, f.w, f.h);
}

/** Register the ghost as its own one-frame texture (its bespoke off-white art, GDD "Avatars and equipment"). */
function registerGhost(scene: Phaser.Scene): void {
  if (scene.textures.exists(GHOST_TEX)) return;
  const tex = scene.textures.addCanvas(GHOST_TEX, paintCanvas(FRAME_W, FRAME_H, ghostDraw));
  tex?.add(GHOST_FRAME, 0, 0, 0, FRAME_W, FRAME_H);
}

/**
 * Register both avatar textures on the scene's texture manager: the multi-style
 * base sheet (every kind × style × facing × frame), and the standalone ghost
 * sprite for the easter egg. Idempotent, so it's safe to call on every scene create.
 */
export function registerAvatarTextures(scene: Phaser.Scene): void {
  registerSheet(scene);
  registerGhost(scene);
}

/** The frame key for one avatar frame within `AVATAR_TEX`. */
export function avatarFrameName(kind: Kind, style: string, facing: Facing, frame: FrameName): string {
  return frameName(kind, style, facing, frame);
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

/** The body pose for an equipment use, by progress through the action: a brief wind-up, then
 *  the strike pose held through the recovery (matching `STRIKE_PEAK`). The rig extends the main
 *  arm in each, so the trogg's arm actually reaches. */
export function attackFrame(phase: number): FrameName {
  return phase < STRIKE_PEAK ? "attack_a" : "attack_b";
}
