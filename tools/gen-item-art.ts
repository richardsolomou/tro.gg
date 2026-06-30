/**
 * Generates the indexed world-prop art in `shared/item_art.ts` — the ground/
 * inventory tools (pickaxe, shovel, sword), their per-facing in-hand frames, the
 * stone resource, and the boulder.
 *
 * Same Pokémon Gold/Silver pipeline and helpers as the avatar art: flat shapes
 * in a tight palette, painted on their own layer, then a single dilation pass
 * traces a crisp dark outline around the silhouette. Items carry no baked shadow
 * — the world renderer drops its own contact shadow under a ground item.
 *
 * Each holdable also gets directional held frames (`<id>_side` / `_up` / `_down`):
 * one canonical combat-ready pose pointing right, emitted as clean 90° rotations,
 * which the renderer pins to the trogg's hand (`left` mirrors `side`).
 *
 * Pipeline: `pnpm item-art` (this tool) → `shared/item_art.ts` → the renderer in
 * `sprites.ts` (`blitArt`) → `src/game/items.ts` texture. Edit the draw code
 * here, never the generated maps.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rgbaSink, type PixelSink } from "../shared/sprites.ts";
import { dot, fmtArt, line, outlinePass, quantize, rect } from "./pixel_paint.ts";

/** Every prop is painted on this square so they share one atlas cell size. */
const W = 24;
const H = 24;

const WOOD_LT = 0x9a6330;
const WOOD = 0x6b3a1d;
const WOOD_DK = 0x3f230e;
const STEEL_LT = 0xe6edf0;
const STEEL = 0xaeb9bc;
const STEEL_DK = 0x647176;
const GOLD = 0xf2c94c;
const GOLD_DK = 0xa87522;
const BRASS = 0xc49a45;
const BRASS_DK = 0x7a5522;
const ROCK = 0x74705c;
const ROCK_LT = 0xb4ac78;
const ROCK_DK = 0x45402d;
const ROCK_DEEP = 0x2b2419;
const OUT_TOOL = 0x15120f;
const OUT_ROCK = 0x18150f;

function drawStone(p: PixelSink): void {
  // A small mined chip: angular rows, one high-value facet, and a dark floor edge.
  rect(p, 9, 12, 7, 1, ROCK_DK);
  rect(p, 7, 13, 11, 2, ROCK);
  rect(p, 8, 15, 10, 2, ROCK);
  rect(p, 10, 17, 7, 1, ROCK_DK);
  rect(p, 9, 13, 4, 2, ROCK_LT);
  rect(p, 13, 14, 3, 1, ROCK_DK);
  rect(p, 14, 15, 3, 2, ROCK_DEEP);
  dot(p, 8, 15, ROCK_LT);
  dot(p, 11, 16, ROCK_DK);
}

function drawBoulder(p: PixelSink): void {
  // GSC boulder: a squat blocky silhouette with chunky facets, not a smooth blob.
  rect(p, 9, 4, 7, 1, ROCK_DK);
  rect(p, 7, 5, 11, 2, ROCK);
  rect(p, 5, 7, 15, 3, ROCK);
  rect(p, 4, 10, 17, 5, ROCK);
  rect(p, 5, 15, 15, 3, ROCK_DK);
  rect(p, 7, 18, 10, 2, ROCK_DEEP);
  rect(p, 8, 6, 6, 3, ROCK_LT);
  rect(p, 6, 9, 5, 2, ROCK_LT);
  rect(p, 12, 8, 4, 2, ROCK_DK);
  rect(p, 15, 10, 4, 3, ROCK_DK);
  rect(p, 16, 14, 3, 3, ROCK_DEEP);
  rect(p, 9, 13, 5, 1, ROCK_DK);
  dot(p, 6, 15, ROCK_LT);
  dot(p, 13, 18, ROCK);
}

// ── holdable poses ───────────────────────────────────────────────────────────────
// Each holdable has two views, both gripped at the canvas centre (≈12,12, where the
// renderer pins the fist): a SIDE profile (business end leading right, +x) for the
// left/right facings, and a TOP-DOWN view (business end toward the camera, +y) for the
// up/down facings — so up/down show the item from above, not the side shape rotated.
// `left` mirrors the side art; the up frame is the top view turned 180°; the upright
// `<id>` icon (overworld + inventory) is the side profile stood up.

/** Sword, side: pommel/grip at centre, blade leading right. */
function drawSwordSide(p: PixelSink): void {
  rect(p, 5, 10, 3, 4, GOLD); // pommel
  rect(p, 6, 13, 2, 1, GOLD_DK);
  rect(p, 8, 11, 5, 2, WOOD); // grip (the fist sits here)
  rect(p, 8, 12, 5, 1, WOOD_DK);
  rect(p, 13, 8, 2, 8, GOLD); // heavy crossguard
  rect(p, 13, 14, 2, 2, GOLD_DK);
  rect(p, 15, 9, 6, 5, STEEL); // broad blade
  rect(p, 15, 9, 6, 1, STEEL_LT);
  rect(p, 16, 12, 5, 2, STEEL_DK);
  rect(p, 21, 10, 1, 3, STEEL);
  dot(p, 22, 11, STEEL_LT);
}

/** Sword, top-down: blade foreshortened toward the camera, broad crossguard seen from
 *  above, pommel nearest the hand. The grip sits on the canvas centre (≈12,12) where the
 *  fist pins, so the hand holds the handle — pommel just above it, blade leading down. */
function drawSwordTop(p: PixelSink): void {
  rect(p, 10, 7, 4, 3, GOLD); // pommel just above the hand
  rect(p, 11, 10, 2, 4, WOOD);
  rect(p, 12, 11, 1, 3, WOOD_DK);
  rect(p, 6, 14, 12, 2, GOLD); // broad crossguard
  rect(p, 7, 15, 10, 1, GOLD_DK);
  rect(p, 10, 16, 4, 4, STEEL);
  rect(p, 10, 16, 2, 4, STEEL_LT);
  rect(p, 12, 17, 2, 4, STEEL_DK);
  rect(p, 11, 20, 2, 2, STEEL);
  dot(p, 11, 22, STEEL_LT);
  dot(p, 12, 22, STEEL);
}

/** Pickaxe, side: handle into the hand at centre; the head crosses the handle at the
 *  leading (right) end as a curved double pick whose points sweep back toward the
 *  handle (so the tips read vertical). */
function drawPickaxeSide(p: PixelSink): void {
  rect(p, 5, 11, 9, 3, WOOD); // handle into the hand
  rect(p, 5, 13, 9, 1, WOOD_DK);
  rect(p, 13, 9, 4, 6, STEEL_DK); // eye/socket
  rect(p, 13, 9, 4, 2, STEEL);
  rect(p, 16, 7, 4, 3, STEEL); // upper blade shoulder
  rect(p, 18, 6, 2, 1, STEEL_LT);
  rect(p, 17, 14, 4, 3, STEEL_DK); // lower blade shoulder
  rect(p, 18, 17, 2, 1, STEEL);
}

/** Pickaxe, top-down: only a short handle stub at the grip — held facing the camera it tucks
 *  under the arm, barely seen — with the head right at the hand and the striking pick driving a
 *  bold point toward the camera (the boulder the trogg faces), a stubby poll on the back. */
function drawPickaxeTop(p: PixelSink): void {
  rect(p, 11, 9, 3, 4, WOOD); // short handle stub at the grip
  rect(p, 12, 9, 2, 4, WOOD_DK);
  rect(p, 8, 13, 8, 3, STEEL_DK); // head boss at the hand
  rect(p, 8, 13, 8, 1, STEEL_LT);
  rect(p, 6, 13, 2, 2, STEEL);
  rect(p, 11, 16, 3, 3, STEEL);
  rect(p, 12, 17, 2, 4, STEEL_DK);
  dot(p, 12, 21, STEEL);
}

/** Pickaxe, top-down for the *up* facing: the trogg's back is to us (bottom of the frame), so
 *  the wooden shaft trails *down* toward the camera, behind the body, where it stays visible;
 *  the head and pick are higher, pointing the way the trogg faces (up/away). */
function drawPickaxeTopUp(p: PixelSink): void {
  rect(p, 11, 11, 3, 11, WOOD); // full shaft trailing back toward the camera
  rect(p, 12, 11, 2, 11, WOOD_DK);
  rect(p, 8, 8, 8, 3, STEEL_DK); // head boss at the hand
  rect(p, 8, 8, 8, 1, STEEL_LT);
  rect(p, 6, 9, 2, 2, STEEL);
  rect(p, 11, 6, 3, 2, STEEL);
  dot(p, 12, 5, STEEL_LT);
}

/** Shovel, side: handle into the hand at centre, spade blade leading right. */
function drawShovelSide(p: PixelSink): void {
  rect(p, 4, 11, 11, 3, WOOD); // handle
  rect(p, 4, 13, 11, 1, WOOD_DK);
  rect(p, 14, 9, 3, 6, BRASS_DK); // socket
  rect(p, 15, 10, 5, 5, BRASS); // square-shouldered spade
  rect(p, 18, 11, 3, 3, BRASS);
  rect(p, 16, 10, 2, 2, GOLD);
  dot(p, 21, 12, BRASS_DK);
}

/** Shovel, top-down: the spade seen flat, broad toward the camera, handle into the hand. */
function drawShovelTop(p: PixelSink): void {
  rect(p, 11, 5, 3, 8, WOOD); // handle from the hand
  rect(p, 12, 5, 2, 8, WOOD_DK);
  rect(p, 9, 12, 7, 2, BRASS_DK); // socket
  rect(p, 7, 14, 11, 3, BRASS);
  rect(p, 8, 17, 9, 2, BRASS);
  rect(p, 10, 14, 4, 2, GOLD);
  dot(p, 12, 20, BRASS_DK);
}

/** Round wooden shield: a steel rim, a planked face lit from the top-left, a central boss.
 *  Round reads the same from any facing, so the one drawing serves the side and top views;
 *  it's an off-hand item, so the renderer pins it to the off hand. */
function drawShield(p: PixelSink): void {
  rect(p, 9, 4, 6, 1, STEEL_DK);
  rect(p, 6, 5, 12, 2, STEEL_DK);
  rect(p, 4, 7, 16, 4, STEEL_DK);
  rect(p, 4, 11, 16, 5, STEEL_DK);
  rect(p, 6, 16, 12, 3, STEEL_DK);
  rect(p, 9, 19, 6, 1, STEEL_DK);
  rect(p, 7, 7, 10, 9, WOOD);
  rect(p, 8, 6, 7, 3, WOOD_LT);
  rect(p, 8, 16, 8, 2, WOOD_DK);
  line(p, 12, 6, 12, 18, WOOD_DK);
  rect(p, 10, 10, 5, 5, STEEL);
  rect(p, 11, 10, 3, 2, STEEL_LT);
  dot(p, 12, 12, STEEL_DK);
}

/** Rotate a square W×H RGBA buffer 90°; `cw` clockwise (→ becomes ↓), else CCW (→ becomes ↑). */
function rot90(src: Uint8Array, cw: boolean): Uint8Array {
  const dst = new Uint8Array(src.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = cw ? y : W - 1 - y;
      const sy = cw ? H - 1 - x : x;
      const s = (sy * W + sx) * 4;
      const d = (y * W + x) * 4;
      dst[d] = src[s]!; dst[d + 1] = src[s + 1]!; dst[d + 2] = src[s + 2]!; dst[d + 3] = src[s + 3]!;
    }
  return dst;
}

function paint(draw: (p: PixelSink) => void): Uint8Array {
  const buf = new Uint8Array(W * H * 4);
  draw(rgbaSink(buf, W, H));
  return buf;
}

/** The four held frames + the icon from a holdable's two views. The side profile (→)
 *  serves left/right and, stood upright (CCW), the `<id>` icon; the top-down view (↓)
 *  serves down and, turned 180°, up. */
function paintHeld(spec: HeldSpec): { icon: Uint8Array; side: Uint8Array; up: Uint8Array; down: Uint8Array } {
  const side = paint(spec.side);
  const top = paint(spec.top);
  const icon = rot90(side, false); // side profile stood upright
  const down = top;
  // up: a dedicated drawing when given (drawn already in up orientation), else the top view turned 180°
  const up = spec.topUp ? paint(spec.topUp) : rot90(rot90(top, true), true);
  for (const layer of [icon, side, up, down]) outlinePass(layer, OUT_TOOL, W, H);
  return { icon, side, up, down };
}

interface HeldSpec {
  /** Side profile (business end leading right) — left/right facings + the upright icon. */
  side: (p: PixelSink) => void;
  /** Top-down view (business end toward the camera) — the down facing, and (180°) the up facing. */
  top: (p: PixelSink) => void;
  /** Optional dedicated up-facing top-down view, drawn directly in up orientation. Use when the
   *  down and up views genuinely differ (e.g. a handle hidden under the arm in front but visible
   *  behind the back). Defaults to `top` turned 180°. */
  topUp?: (p: PixelSink) => void;
}

/** Holdables: a side and a top-down drawing each, emitted as the upright `<id>` icon
 *  plus the per-facing held frames `<id>_down` / `<id>_up` / `<id>_side`. */
const HELD: Record<string, HeldSpec> = {
  sword: { side: drawSwordSide, top: drawSwordTop },
  pickaxe: { side: drawPickaxeSide, top: drawPickaxeTop, topUp: drawPickaxeTopUp },
  shovel: { side: drawShovelSide, top: drawShovelTop },
  shield: { side: drawShield, top: drawShield }, // round: the one drawing reads from any facing
};

interface ItemSpec {
  draw: (p: PixelSink) => void;
  outline: number;
}

/** Non-holdable props: a single upright drawing each. */
const ITEMS: Record<string, ItemSpec> = {
  stone: { draw: drawStone, outline: OUT_ROCK },
  boulder: { draw: drawBoulder, outline: OUT_ROCK },
};

function paintItem(spec: ItemSpec): Uint8Array {
  const layer = new Uint8Array(W * H * 4);
  spec.draw(rgbaSink(layer, W, H));
  outlinePass(layer, spec.outline, W, H);
  return layer;
}

const header = `/**
 * Indexed source art for items: the holdable tools (each as the upright \`<id>\` icon
 * plus per-facing held frames — \`_down\`/\`_up\` top-down views and a \`_side\` profile)
 * and the stone/boulder props.
 *
 * Each entry is a ${W}x${H} text pixel map in the same format as \`sprite_art.ts\`;
 * \`.\` is transparent and any other character indexes the entry's local RGBA
 * palette via PIXEL_KEYS. Rendered through \`blitArt\` in \`sprites.ts\`.
 *
 * GENERATED by \`tools/gen-item-art.ts\` (\`pnpm item-art\`). The paint logic there
 * is the source of truth — edit it and regenerate, don't hand-edit this file.
 */

import type { IndexedSpriteArt } from "./sprite_art";

export const ITEM_ART_W = ${W};
export const ITEM_ART_H = ${H};

`;

const entries = Object.entries(ITEMS).map(
  ([name, spec]) => `  ${JSON.stringify(name)}: ${fmtArt(quantize(paintItem(spec), W, H), "  ")},`,
);

const heldEntries = Object.entries(HELD).flatMap(([name, spec]) => {
  const f = paintHeld(spec);
  // `<id>` is the overworld + inventory icon; `_down`/`_up` are the top-down held views;
  // `_side` is the side profile (`left` mirrors it).
  return [
    `  ${JSON.stringify(name)}: ${fmtArt(quantize(f.icon, W, H), "  ")},`,
    `  ${JSON.stringify(`${name}_down`)}: ${fmtArt(quantize(f.down, W, H), "  ")},`,
    `  ${JSON.stringify(`${name}_up`)}: ${fmtArt(quantize(f.up, W, H), "  ")},`,
    `  ${JSON.stringify(`${name}_side`)}: ${fmtArt(quantize(f.side, W, H), "  ")},`,
  ];
});

const out = header + `export const ITEM_ART: Record<string, IndexedSpriteArt> = {\n${[...entries, ...heldEntries].join("\n")}\n};\n`;

const OUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "item_art.ts");
writeFileSync(OUT_PATH, out);
console.log(`Wrote ${entries.length + heldEntries.length} item maps → ${OUT_PATH}`);
