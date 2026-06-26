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
  type PixelSink,
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
let ghostSheet: Texture | undefined;
const cache = new Map<string, Texture>();
const ghostCache = new Map<string, Texture>();

/** Paint a full sprite sheet into an offscreen canvas and wrap it as a nearest
 *  texture. `paint` drives the pixels — the avatar art, or a recolour of it. */
function buildSheet(paint: (sink: PixelSink) => void): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_W;
  canvas.height = SHEET_H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SHEET_W, SHEET_H);
  paint(rgbaSink(img.data, SHEET_W, SHEET_H));
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/** Slice one frame out of a painted sheet, caching the sub-texture. */
function frameTexture(source: Texture, store: Map<string, Texture>, key: string, kind: Kind, facing: Facing, frame: FrameName): Texture {
  let tex = store.get(key);
  if (!tex) {
    const r = frameRect(kind, facing, frame);
    tex = new Texture({ source: source.source, frame: new Rectangle(r.x, r.y, r.w, r.h) });
    store.set(key, tex);
  }
  return tex;
}

/** The sub-texture for one avatar frame, sliced from the shared sheet. */
export function avatarTexture(kind: Kind, facing: Facing, frame: FrameName): Texture {
  if (!sheet) sheet = buildSheet(paintSheet);
  return frameTexture(sheet, cache, `${kind}_${facing}_${frame}`, kind, facing, frame);
}

/**
 * A trogg frame painted as a flat white silhouette (every pixel forced white,
 * each keeping its own alpha) — the pale apparition for the join easter egg
 * (`ghost-trogg`, see world.ts). No tint needed; it is white in the texture.
 */
export function ghostTexture(facing: Facing, frame: FrameName): Texture {
  if (!ghostSheet) {
    ghostSheet = buildSheet((sink) => paintSheet({ set: (x, y, _colour, alpha) => sink.set(x, y, 0xffffff, alpha) }));
  }
  return frameTexture(ghostSheet, ghostCache, `${facing}_${frame}`, "trogg", facing, frame);
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
