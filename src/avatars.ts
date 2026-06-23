import { Rectangle, Texture } from "pixi.js";
import {
  FRAME_H,
  FRAME_W,
  SHEET_H,
  SHEET_W,
  frameRect,
  paintSheet,
  rgbaSink,
  type Facing,
  type FrameName,
  type Kind,
} from "@trogg/shared";

/**
 * Client-side avatar textures. The trogg/Hog art is defined once in
 * `shared/sprites.ts` as pure paint logic; here we paint the whole sheet into a
 * canvas once and hand PixiJS nearest-neighbour sub-textures per frame — the
 * same runtime-painted-texture approach as `terrain.ts`, so the client carries
 * no image asset to load (the committed PNG is the reviewable export, not a
 * runtime dependency). Frame textures share one GPU source and are cached.
 */

let sheet: Texture | undefined;
const cache = new Map<string, Texture>();

/** Paint the sheet into an offscreen canvas and wrap it as a nearest texture. */
function buildSheet(): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SHEET_W, SHEET_H);
  paintSheet(rgbaSink(img.data, SHEET_W, SHEET_H));
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/** The sub-texture for one avatar frame, sliced from the shared sheet. */
export function avatarTexture(kind: Kind, facing: Facing, frame: FrameName): Texture {
  if (!sheet) sheet = buildSheet();
  const key = `${kind}_${facing}_${frame}`;
  let tex = cache.get(key);
  if (!tex) {
    const r = frameRect(kind, facing, frame);
    tex = new Texture({ source: sheet.source, frame: new Rectangle(r.x, r.y, r.w, r.h) });
    cache.set(key, tex);
  }
  return tex;
}

/** Native frame size in art pixels — callers scale this to the tile. */
export const AVATAR_FRAME = { width: FRAME_W, height: FRAME_H } as const;

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
