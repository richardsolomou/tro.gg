/**
 * Generates the indexed avatar art in `shared/sprite_art.ts`.
 *
 * The committed `sprite_art.ts` is indexed pixel maps the runtime and tests
 * consume, but those maps are tedious to author by hand. This tool combines the
 * per-creature paint logic in `tools/art/` (one file per creature — `trogg.ts`,
 * `hog.ts`, `buff.ts`, `dino.ts`, `chicken.ts`, `ghost.ts`, over the shared
 * `rig.ts`), paints each 32x48 frame, and quantises it into a per-frame palette
 * + key map.
 *
 * Art direction is Pokémon Gold/Silver: a tight flat palette and chunky flat
 * shapes, with a single dilation pass tracing a clean dark outline around the
 * whole silhouette (`outlinePass`), composited over a soft ground shadow. To
 * edit a creature, open its file in `tools/art/`; this combiner only wires them
 * together and emits.
 *
 * Pipeline: `pnpm sprite-art` (this tool) → `shared/sprite_art.ts` → the
 * renderer in `sprites.ts` → `pnpm sprites` → the committed PNG/atlas.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FRAME_H, FRAME_W, frames, rgbaSink, type Facing, type FrameName, type Kind, type PixelSink } from "../shared/sprites.ts";
import { compositeOver, disc, fmtArt, outlinePass, PIXEL_KEYS, quantize } from "./pixel_paint.ts";
import type { View } from "./art/rig.ts";
import { TROGG_SKINS, troggBody, troggDraw, troggMainArm } from "./art/trogg.ts";
import { HOG_SKINS, hogBody, hogDraw, hogMainArm } from "./art/hog.ts";
import { BUFF, buffBody, buffDraw, buffMainArm } from "./art/buff.ts";
import { DINO, dinoBody, dinoDraw, dinoMainArm } from "./art/dino.ts";
import { CHICK, chickenDraw } from "./art/chicken.ts";
import { GHOST, ghostDrawArt } from "./art/ghost.ts";

// ── frame painting: dispatch, layer, outline, composite ─────────────────────────

function outlineColour(kind: Kind, style: string): number {
  if (kind === "trogg") return (TROGG_SKINS[style] ?? TROGG_SKINS.moss!).out;
  if (style === "buff") return BUFF.out;
  if (style === "dino") return DINO.out;
  if (style === "chicken") return CHICK.out;
  return (HOG_SKINS[style] ?? HOG_SKINS.classic!).out;
}

function drawCharacter(p: PixelSink, kind: Kind, style: string, view: View, frame: FrameName): void {
  if (kind === "trogg") return troggDraw(p, view, frame, TROGG_SKINS[style] ?? TROGG_SKINS.moss!);
  if (style === "buff") return buffDraw(p, view, frame);
  if (style === "dino") return dinoDraw(p, view, frame);
  // The chicken's wings are baked, not rig-driven, so it has no attack pose — render attack as idle.
  const f: FrameName = frame === "attack_a" || frame === "attack_b" ? "idle" : frame;
  if (style === "chicken") return chickenDraw(p, view, f);
  hogDraw(p, view, frame, HOG_SKINS[style] ?? HOG_SKINS.classic!);
}

/** The bare character fill for a frame — no outline, no shadow. The runtime composites the
 *  layer stack and runs the single outline pass over the result (`composeAvatarFrame`), so a
 *  worn layer shares one unified silhouette; the outline colour rides each frame's art. */
function paintFill(kind: Kind, style: string, facing: Facing, frame: FrameName): Uint8Array {
  const layer = new Uint8Array(FRAME_W * FRAME_H * 4);
  const cs = rgbaSink(layer, FRAME_W, FRAME_H);
  const flip = facing === "left";
  const p: PixelSink = { set: (x, y, c) => cs.set(flip ? FRAME_W - 1 - x : x, y, c) };
  const view: View = facing === "left" || facing === "right" ? "side" : facing;
  drawCharacter(p, kind, style, view, frame);
  return layer;
}

/** Which (kind, style) draw their limbs from the rig and so can have a near-arm overlay: the
 *  trogg and every hog but the chicken (whose wings are baked, not rig limbs). */
function isRigged(kind: Kind, style: string): boolean {
  return kind === "trogg" || (kind === "hog" && style !== "chicken");
}

/** Paint one rigged creature's part (body or main arm) for a frame, honouring the left-mirror
 *  flip — used to derive the near-arm overlay that rides over a held item. */
function paintPart(kind: Kind, style: string, facing: Facing, frame: FrameName, part: "body" | "arm"): Uint8Array {
  const layer = new Uint8Array(FRAME_W * FRAME_H * 4);
  const cs = rgbaSink(layer, FRAME_W, FRAME_H);
  const flip = facing === "left";
  const p: PixelSink = { set: (x, y, c, a) => cs.set(flip ? FRAME_W - 1 - x : x, y, c, a) };
  const view: View = facing === "left" || facing === "right" ? "side" : facing;
  const body = part === "body";
  if (kind === "trogg") {
    const skin = TROGG_SKINS[style] ?? TROGG_SKINS.moss!;
    if (body) troggBody(p, view, frame, skin);
    else troggMainArm(p, view, frame, skin);
  } else if (style === "buff") {
    if (body) buffBody(p, view, frame);
    else buffMainArm(p, view, frame);
  } else if (style === "dino") {
    if (body) dinoBody(p, view, frame);
    else dinoMainArm(p, view, frame);
  } else {
    const skin = HOG_SKINS[style] ?? HOG_SKINS.classic!;
    if (body) hogBody(p, view, frame, skin);
    else hogMainArm(p, view, frame, skin);
  }
  return layer;
}

const opaqueAt = (buf: Uint8Array, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < FRAME_W && y < FRAME_H && buf[(y * FRAME_W + x) * 4 + 3]! > 0;

/** The near-arm overlay drawn over a held item: the arm's own pixels plus the outer outline that
 *  belongs to it, lifted out of the already-outlined full silhouette so it carries no interior
 *  seam against the body and needs no second outline pass at render time. Null when the arm is
 *  empty for this frame (facing up, where the arm sits behind the body and the item does too). */
function armOverlay(full: Uint8Array, body: Uint8Array, arm: Uint8Array, outline: number): Uint8Array | null {
  if (!full.some((_, i) => i % 4 === 3 && arm[i]! > 0)) return null;
  const outlined = full.slice();
  outlinePass(outlined, outline, FRAME_W, FRAME_H);
  const or = (outline >> 16) & 0xff, og = (outline >> 8) & 0xff, ob = outline & 0xff;
  const isOutline = (i: number) => outlined[i + 3] === 255 && outlined[i] === or && outlined[i + 1] === og && outlined[i + 2] === ob;
  const armNeighbour = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && opaqueAt(arm, x + dx, y + dy)) return true;
    return false;
  };
  const out = new Uint8Array(FRAME_W * FRAME_H * 4);
  for (let y = 0; y < FRAME_H; y++)
    for (let x = 0; x < FRAME_W; x++) {
      const i = (y * FRAME_W + x) * 4;
      const keep = opaqueAt(arm, x, y) || (!opaqueAt(body, x, y) && isOutline(i) && armNeighbour(x, y));
      if (keep) out.set(outlined.subarray(i, i + 4), i);
    }
  return out;
}

/** A sink that paints at a fixed alpha — used only for the ground shadow. */
function rgbaSinkAlpha(data: Uint8Array, alpha: number): PixelSink {
  const base = rgbaSink(data, FRAME_W, FRAME_H);
  return { set: (x, y, c) => base.set(x, y, c, alpha) };
}

function paintGhost(): Uint8Array {
  const layer = new Uint8Array(FRAME_W * FRAME_H * 4);
  ghostDrawArt(rgbaSink(layer, FRAME_W, FRAME_H));
  outlinePass(layer, GHOST.out, FRAME_W, FRAME_H);
  const data = new Uint8Array(FRAME_W * FRAME_H * 4);
  disc(rgbaSinkAlpha(data, 70), 15.5, 43, 12, 3.4, 0x000000);
  compositeOver(data, layer);
  return data;
}

// ── emit ────────────────────────────────────────────────────────────────────────

const header = `/**
 * Indexed source art for the avatar sprite sheet.
 *
 * Each frame is a 32x48 text pixel map. \`.\` is transparent; any other
 * character indexes into that frame's local RGBA palette using PIXEL_KEYS.
 * The sprite renderer in \`sprites.ts\` blits these maps into the shared sheet
 * and the runtime canvas texture.
 *
 * GENERATED by \`tools/gen-sprite-art.ts\` (\`pnpm sprite-art\`). The paint logic
 * lives in \`tools/art/\` (one file per creature) — edit it and regenerate, don't
 * hand-edit this file.
 */

export interface IndexedSpriteArt {
  palette: readonly number[];
  pixels: readonly string[];
  /** Outline colour for the dilation pass run over the composited layer stack at render time
   *  (\`composeAvatarFrame\`). Present on avatar fills; absent on already-finished art. */
  outline?: number;
}

export const PIXEL_KEYS = ${JSON.stringify(PIXEL_KEYS)};

`;

const armEntries: string[] = [];
const entries = frames().map((f) => {
  const fill = quantize(paintFill(f.kind, f.style, f.facing, f.frame), FRAME_W, FRAME_H);
  const outlineNum = outlineColour(f.kind, f.style);
  const outline = "0x" + (outlineNum >>> 0).toString(16).padStart(6, "0");
  if (isRigged(f.kind, f.style)) {
    const overlay = armOverlay(
      paintFill(f.kind, f.style, f.facing, f.frame),
      paintPart(f.kind, f.style, f.facing, f.frame, "body"),
      paintPart(f.kind, f.style, f.facing, f.frame, "arm"),
      outlineNum,
    );
    if (overlay) armEntries.push(`  ${JSON.stringify(f.name)}: ${fmtArt(quantize(overlay, FRAME_W, FRAME_H), "  ")},`);
  }
  return `  ${JSON.stringify(f.name)}: ${fmtArt(fill, "  ", `outline: ${outline}`)},`;
});

const ghost = fmtArt(quantize(paintGhost(), FRAME_W, FRAME_H), "");

const out =
  header +
  `export const AVATAR_FRAME_ART: Record<string, IndexedSpriteArt> = {\n${entries.join("\n")}\n};\n\n` +
  `/** The near (main-hand) arm lifted out of each front-facing frame's outlined silhouette, keyed\n` +
  ` *  by the same \`frameName\`. The runtime draws it over a held item so the hand grips the weapon\n` +
  ` *  instead of the weapon covering the arm. No \`outline\` field: already finished, blitted as-is. */\n` +
  `export const ARM_OVERLAY_ART: Record<string, IndexedSpriteArt> = {\n${armEntries.join("\n")}\n};\n\n` +
  `export const GHOST_ART: IndexedSpriteArt = ${ghost};\n`;

const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "sprite_art.ts");
writeFileSync(OUT_PATH, out);
console.log(`Wrote ${entries.length} frames + ${armEntries.length} arm overlays + ghost → ${OUT_PATH}`);
