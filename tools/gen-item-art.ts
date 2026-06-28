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
import { disc, dot, fmtArt, line, outlinePass, quantize, rect, shaded } from "./pixel_paint.ts";

/** Every prop is painted on this square so they share one atlas cell size. */
const W = 24;
const H = 24;

const WOOD = 0x6b3f24;
const WOOD_DK = 0x46280f;
const STEEL = 0xccd6dc;
const STEEL_DK = 0x8b969c;
const GOLD = 0xe6b53f;
const GOLD_DK = 0xb6862a;
const BRASS = 0xc6a05a;
const BRASS_DK = 0x8f6f38;
const ROCK = 0x8a7257;
const ROCK_LT = 0xa88c6c;
const ROCK_DK = 0x5b4733;
const OUT_TOOL = 0x1a1714;
const OUT_ROCK = 0x241c12;

function drawStone(p: PixelSink): void {
  // a small chunky chip of cave rock
  shaded(p, 11.5, 15, 5, 3.6, ROCK, ROCK_DK);
  disc(p, 10, 13.5, 2.2, 1.5, ROCK_LT);
  line(p, 13, 13, 14, 16, ROCK_DK);
}

function drawBoulder(p: PixelSink): void {
  // a big rounded rock nearly filling the cell, lit from the top-left
  shaded(p, 12, 13, 9.6, 9, ROCK, ROCK_DK);
  disc(p, 8, 9, 3.6, 2.8, ROCK_LT);
  line(p, 14, 7, 16, 17, ROCK_DK);
  line(p, 15, 12, 19, 14, ROCK_DK);
  dot(p, 7, 17, ROCK_LT); dot(p, 17, 19, ROCK_LT);
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
  disc(p, 7.5, 11.5, 1.6, 1.6, GOLD); // pommel
  rect(p, 9, 11, 4, 2, WOOD); // grip (the fist sits here)
  dot(p, 10, 12, WOOD_DK); dot(p, 12, 12, WOOD_DK);
  rect(p, 13, 9, 2, 6, GOLD); // crossguard (across the blade)
  rect(p, 13, 14, 2, 1, GOLD_DK);
  rect(p, 15, 10, 7, 3, STEEL); // blade
  for (let x = 15; x <= 20; x++) dot(p, x, 11, STEEL_DK); // fuller
  dot(p, 22, 11, STEEL); // tip
}

/** Sword, top-down: blade foreshortened toward the camera, broad crossguard seen from
 *  above, pommel nearest the hand. */
function drawSwordTop(p: PixelSink): void {
  disc(p, 11.5, 6.5, 1.6, 1.6, GOLD); // pommel near the hand
  rect(p, 11, 8, 2, 3, WOOD); dot(p, 12, 9, WOOD_DK); dot(p, 12, 10, WOOD_DK); // grip
  rect(p, 7, 11, 10, 2, GOLD); rect(p, 7, 12, 10, 1, GOLD_DK); // broad crossguard
  rect(p, 10, 13, 4, 2, STEEL); // blade shoulders
  rect(p, 11, 15, 2, 3, STEEL); // blade foreshortened toward camera
  for (let y = 13; y <= 17; y++) dot(p, 12, y, STEEL_DK); // fuller
  dot(p, 11, 18, STEEL); dot(p, 12, 18, STEEL); dot(p, 11.5, 19, STEEL); // point
}

/** Pickaxe, side: handle into the hand at centre; the head crosses the handle at the
 *  leading (right) end as a curved double pick whose points sweep back toward the
 *  handle (so the tips read vertical). */
function drawPickaxeSide(p: PixelSink): void {
  rect(p, 5, 11, 9, 2, WOOD); // handle into the hand
  for (let x = 5; x <= 13; x++) dot(p, x, 12, WOOD_DK);
  rect(p, 13, 10, 3, 4, STEEL_DK); // eye/socket where the handle meets the head
  rect(p, 13, 10, 3, 1, STEEL);
  // upper pick: bulges forward off the socket, then curves up and back to a point
  line(p, 16, 10, 18, 8, STEEL); line(p, 16, 11, 18, 9, STEEL_DK);
  line(p, 18, 8, 15, 4, STEEL); dot(p, 14, 3, STEEL);
  // lower pick: bulges forward, then curves down and back to a point
  line(p, 16, 13, 18, 15, STEEL); line(p, 16, 12, 18, 14, STEEL_DK);
  line(p, 18, 15, 15, 19, STEEL); dot(p, 14, 20, STEEL);
}

/** Pickaxe, top-down: only a short handle stub at the grip — held facing the camera it tucks
 *  under the arm, barely seen — with the head right at the hand and the striking pick driving a
 *  bold point toward the camera (the boulder the trogg faces), a stubby poll on the back. */
function drawPickaxeTop(p: PixelSink): void {
  rect(p, 11, 10, 2, 3, WOOD); // short handle stub at the grip, mostly hidden under the arm
  dot(p, 12, 10, WOOD_DK); dot(p, 12, 11, WOOD_DK); dot(p, 12, 12, WOOD_DK);
  rect(p, 9, 13, 6, 2, STEEL_DK); // head boss at the hand
  rect(p, 9, 13, 6, 1, STEEL);
  rect(p, 8, 13, 1, 2, STEEL); dot(p, 7, 13, STEEL_DK); // stubby poll on the back
  // striking pick: a bold tapering point down toward the camera/boulder
  rect(p, 11, 15, 2, 3, STEEL);
  dot(p, 12, 15, STEEL_DK);
  dot(p, 11, 18, STEEL); dot(p, 12, 18, STEEL);
  dot(p, 11.5, 19, STEEL); dot(p, 11.5, 20, STEEL); // sharp tip
}

/** Pickaxe, top-down for the *up* facing: the trogg's back is to us (bottom of the frame), so
 *  the wooden shaft trails *down* toward the camera, behind the body, where it stays visible;
 *  the head and pick are higher, pointing the way the trogg faces (up/away). */
function drawPickaxeTopUp(p: PixelSink): void {
  rect(p, 11, 11, 2, 11, WOOD); // full shaft trailing back toward the camera, visible behind the trogg
  for (let y = 11; y <= 21; y++) dot(p, 12, y, WOOD_DK);
  rect(p, 9, 9, 6, 2, STEEL_DK); // head boss at the hand
  rect(p, 9, 10, 6, 1, STEEL);
  rect(p, 8, 9, 1, 2, STEEL); dot(p, 7, 10, STEEL_DK); // stubby poll on the back
  // short pick beyond the head, pointing the way the trogg faces (up/away)
  rect(p, 11, 7, 2, 2, STEEL);
  dot(p, 12, 8, STEEL_DK); dot(p, 11.5, 6, STEEL);
}

/** Shovel, side: handle into the hand at centre, spade blade leading right. */
function drawShovelSide(p: PixelSink): void {
  rect(p, 5, 11, 10, 2, WOOD); // handle
  for (let x = 5; x <= 14; x++) dot(p, x, 12, WOOD_DK);
  rect(p, 15, 9, 3, 6, BRASS); // socket
  disc(p, 19, 11.5, 3.4, 3.4, BRASS); // spade
  for (let y = 9; y <= 14; y++) dot(p, 17, y, BRASS_DK);
  dot(p, 21.5, 11.5, BRASS_DK);
}

/** Shovel, top-down: the spade seen flat, broad toward the camera, handle into the hand. */
function drawShovelTop(p: PixelSink): void {
  rect(p, 11, 5, 2, 7, WOOD); // handle from the hand
  for (let y = 5; y <= 11; y++) dot(p, 12, y, WOOD_DK);
  rect(p, 10, 12, 4, 1, WOOD_DK); // socket
  rect(p, 8, 13, 8, 3, BRASS); // broad spade shoulders
  disc(p, 12, 16, 4, 3, BRASS); // spade
  for (let x = 8; x <= 15; x++) dot(p, x, 13, BRASS_DK);
  dot(p, 12, 19, BRASS_DK); // tip
}

/** Round wooden shield: a steel rim, a planked face lit from the top-left, a central boss.
 *  Round reads the same from any facing, so the one drawing serves the side and top views;
 *  it's an off-hand item, so the renderer pins it to the off hand. */
function drawShield(p: PixelSink): void {
  disc(p, 12, 12, 8, 8.6, STEEL_DK); // steel rim (outer disc)
  shaded(p, 12, 12, 6.8, 7.4, WOOD, WOOD_DK); // planked face
  line(p, 12, 5, 12, 19, WOOD_DK); // central plank seam
  disc(p, 12, 12, 2.4, 2.4, STEEL); // metal boss
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
