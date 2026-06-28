/**
 * Dev-only sprite previewer for eyeballing the generated art. Not committed art.
 *
 * Modes:
 *   tsx tools/preview-sprites.ts <name> [name...]      one row of frames → /tmp/sprite-preview.png
 *   tsx tools/preview-sprites.ts --ascii <name>...     print each frame as a text grid + legend
 *   tsx tools/preview-sprites.ts --sheet=<set> [...]   contact sheet → /tmp/sprite-preview.png
 *
 * `<set>` for --sheet:
 *   trogg_moss        a creature group: rows = facings, cols = frames (idle/walk/run/attack)
 *   items             every entry in ITEM_ART, wrapped into a grid
 *   item:pickaxe      one item's views (<id> / _down / _up / _side)
 *   held:pickaxe      the item *wielded* — rows = facings, cols = frames, placed by the
 *                     same `heldTransform` the game uses. The headless way to verify a
 *                     held item rides the rig right in every direction. Add a creature with
 *                     `held:pickaxe:trogg_stone` (default `trogg_moss`).
 *
 * `--ascii` is the cheap iteration loop: read exact pixels as text, no image. Render a
 * real PNG (default / --sheet) only for final visual sign-off. Names resolve to avatar
 * frames (`trogg_moss_down_idle`), "ghost", or item-art entries (`pickaxe`, `sword_down`).
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { AVATAR_FRAME_ART, GHOST_ART, PIXEL_KEYS, type IndexedSpriteArt } from "../shared/sprite_art.ts";
import { ITEM_ART, ITEM_ART_W } from "../shared/item_art.ts";
import { ANCHOR, composeAvatarFrame, FACINGS, FRAME_H, FRAME_W, FRAMES, type Facing, type FrameName, type Kind } from "../shared/sprites.ts";
import { quantize } from "./pixel_paint.ts";
import { ART, attackEase, heldTransform } from "../src/game/equipment.ts";

const SCALE = 7;
const PAD = 2;
const KEY_INDEX: Record<string, number> = Object.fromEntries([...PIXEL_KEYS].map((k, i) => [k, i]));

function resolve(name: string): IndexedSpriteArt | undefined {
  if (name === "ghost") return GHOST_ART;
  const avatar = AVATAR_FRAME_ART[name];
  // avatar frames are un-outlined fills now — compose (outline + shadow) for the contact sheet
  if (avatar) return avatar.outline === undefined ? avatar : quantize(composeAvatarFrame(avatar, avatar.outline), FRAME_W, FRAME_H);
  return ITEM_ART[name];
}

// ── arg parsing ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const ascii = argv.includes("--ascii");
const sheetArg = argv.find((a) => a.startsWith("--sheet="))?.slice("--sheet=".length);
const names = argv.filter((a) => !a.startsWith("--"));

// ── png plumbing (shared by every png mode) ─────────────────────────────────────────
function blankCanvas(W: number, H: number): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  const blit = makeBlit(data, W, H);
  for (let y = 0; y < H / SCALE; y++)
    for (let x = 0; x < W / SCALE; x++) {
      const c = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 0x88 : 0x70;
      blit(x, y, c, c, c, 255);
    }
  return data;
}

/** Source-over blit of one art pixel (pre-SCALE coordinates) into the device buffer. */
function makeBlit(data: Uint8Array, W: number, H: number) {
  return (px: number, py: number, r: number, g: number, b: number, a: number) => {
    for (let sy = 0; sy < SCALE; sy++)
      for (let sx = 0; sx < SCALE; sx++) {
        const x = px * SCALE + sx;
        const y = py * SCALE + sy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        const da = data[i + 3]! / 255;
        const saf = a / 255;
        const oa = saf + da * (1 - saf);
        const bl = (s: number, d: number) => (oa === 0 ? 0 : Math.round((s * saf + d * da * (1 - saf)) / oa));
        data[i] = bl(r, data[i]!);
        data[i + 1] = bl(g, data[i + 1]!);
        data[i + 2] = bl(b, data[i + 2]!);
        data[i + 3] = Math.round(oa * 255);
      }
  };
}

function rgbaOf(art: IndexedSpriteArt, ch: string): number {
  return art.palette[KEY_INDEX[ch]!]! >>> 0;
}

/** Draw an indexed art at art-pixel offset (ox, oy). */
function drawArt(blit: ReturnType<typeof makeBlit>, art: IndexedSpriteArt, ox: number, oy: number) {
  for (let y = 0; y < art.pixels.length; y++) {
    const row = art.pixels[y] ?? "";
    for (let x = 0; x < row.length; x++) {
      const k = row[x] ?? ".";
      if (k === ".") continue;
      const c = rgbaOf(art, k);
      blit(ox + x, oy + y, (c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
    }
  }
}

function writePng(data: Uint8Array, W: number, H: number) {
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, body: Uint8Array) => { const tb = new Uint8Array([...type].map((ch) => ch.charCodeAt(0))); const out = new Uint8Array(12 + body.length); const v = new DataView(out.buffer); v.setUint32(0, body.length); out.set(tb, 4); out.set(body, 8); const ci = new Uint8Array(4 + body.length); ci.set(tb, 0); ci.set(body, 4); v.setUint32(8 + body.length, crc32(ci)); return out; };
  const ihdr = new Uint8Array(13); const iv = new DataView(ihdr.buffer); iv.setUint32(0, W); iv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 6;
  const raw = new Uint8Array(H * (1 + W * 4));
  for (let y = 0; y < H; y++) { raw[y * (1 + W * 4)] = 0; raw.set(data.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1); }
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total); let off = 0; for (const c of chunks) { png.set(c, off); off += c.length; }
  writeFileSync("/tmp/sprite-preview.png", png);
}

// ── held mode (creature + item(s), composed through the shared placement) ────────────
// `held:<main>[+<off>][:<creature>]` — a main-hand item and an optional off-hand item
// (e.g. `held:sword+shield`), each placed and z-ordered by the same rig the game uses.
if (sheetArg?.startsWith("held:")) {
  const [, spec, creature = "trogg_moss"] = sheetArg.split(":");
  const [mainItem, offItem] = spec!.split("+");
  const kind: Kind = creature!.startsWith("hog") ? "hog" : "trogg";
  // a representative attack weight per frame: peak use pose on the strike, mid on the wind-up
  const attackOf = (f: FrameName) => (f === "attack_b" ? attackEase(0.5) : f === "attack_a" ? attackEase(0.25) : 0);

  const HELD_PAD = 16; // room for the item to extend past the body
  const cellW = FRAME_W + HELD_PAD * 2;
  const cellH = FRAME_H + HELD_PAD * 2;
  const W = FRAMES.length * cellW * SCALE;
  const H = FACINGS.length * cellH * SCALE;
  const data = blankCanvas(W, H);
  const blit = makeBlit(data, W, H);

  // One held item placed in a cell: its draw closure plus whether it sits behind the body.
  // tile = FRAME_W ⇒ sprite px == frame px, so the screen-space transform composes directly.
  const place = (id: string, slot: "mainHand" | "offHand", facing: Facing, frame: FrameName, ox: number, oy: number) => {
    const t = heldTransform({ kind, item: id, facing, frameName: frame, tile: FRAME_W, attack: attackOf(frame), slot });
    const overlay = ITEM_ART[t.frame];
    if (!overlay) return undefined;
    const cx = ox + ANCHOR.x + (t.x - FRAME_W / 2);
    const cy = oy + ANCHOR.y + (t.y - FRAME_W / 2);
    const m = t.scale * (ART / ITEM_ART_W);
    return { behind: t.behind, draw: () => drawOverlay(blit, overlay, cx, cy, m, t.rotation, t.flipX) };
  };

  FACINGS.forEach((facing: Facing, ri) => {
    FRAMES.forEach((frame: FrameName, ci) => {
      const base = resolve(`${creature}_${facing}_${frame}`);
      if (!base) return;
      const ox = ci * cellW + HELD_PAD;
      const oy = ri * cellH + HELD_PAD;
      const main = place(mainItem!, "mainHand", facing, frame, ox, oy);
      const off = offItem ? place(offItem, "offHand", facing, frame, ox, oy) : undefined;
      // back→front: behind-hand items, body, front-hand items
      for (const h of [off, main]) if (h?.behind) h.draw();
      drawArt(blit, base, ox, oy);
      for (const h of [off, main]) if (h && !h.behind) h.draw();
    });
  });

  writePng(data, W, H);
  console.log(`cols: ${FRAMES.join(", ")}`);
  console.log(`rows: ${FACINGS.join(", ")}`);
  console.log(`held ${spec} on ${creature} → ${FACINGS.length}x${FRAMES.length} grid → /tmp/sprite-preview.png`);
  process.exit(0);
}

/** Nearest-neighbour affine blit of an item: center the art at (cx, cy) in art-px, scaled
 *  by `m` (art-px → cell-px), rotated by `rot` (screen-clockwise), optionally x-mirrored —
 *  the inverse of the runtime's setScale/setRotation, so the composed sheet matches. */
function drawOverlay(blit: ReturnType<typeof makeBlit>, art: IndexedSpriteArt, cx: number, cy: number, m: number, rot: number, flip: boolean) {
  const w = Math.max(...art.pixels.map((r) => r.length));
  const h = art.pixels.length;
  const reach = Math.ceil((Math.max(w, h) * Math.SQRT2 * m) / 2) + 1;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (let py = Math.floor(cy - reach); py <= cy + reach; py++)
    for (let px = Math.floor(cx - reach); px <= cx + reach; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const rx = (dx * cos + dy * sin) / m; // inverse-rotate then inverse-scale
      const ry = (-dx * sin + dy * cos) / m;
      const ax = Math.round((flip ? -rx : rx) + w / 2);
      const ay = Math.round(ry + h / 2);
      if (ay < 0 || ay >= h || ax < 0 || ax >= w) continue;
      const k = art.pixels[ay]![ax] ?? ".";
      if (k === ".") continue;
      const c = rgbaOf(art, k);
      blit(px, py, (c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff);
    }
}

/** A grid of frame names (null = blank cell), with optional axis labels for the legend. */
interface Grid {
  rows: (string | null)[][];
  rowLabels?: string[];
  colLabels?: string[];
}

function buildGrid(): Grid {
  if (sheetArg?.startsWith("item:")) {
    const id = sheetArg.slice("item:".length);
    const views = [id, `${id}_down`, `${id}_up`, `${id}_side`].filter((n) => resolve(n));
    return { rows: [views], colLabels: views };
  }
  if (sheetArg === "items") {
    const all = Object.keys(ITEM_ART);
    const cols = 6;
    const rows: (string | null)[][] = [];
    for (let i = 0; i < all.length; i += cols) rows.push(all.slice(i, i + cols));
    return { rows };
  }
  if (sheetArg) {
    // a creature group like `trogg_moss`: rows = facings, cols = frames
    const rows = FACINGS.map((f) => FRAMES.map((fr) => `${sheetArg}_${f}_${fr}`));
    return { rows, rowLabels: [...FACINGS], colLabels: [...FRAMES] };
  }
  return { rows: [names] };
}

const grid = buildGrid();

// ── ascii mode ──────────────────────────────────────────────────────────────────
if (ascii) {
  const cells = grid.rows.flat().filter((n): n is string => !!n);
  for (const name of cells) {
    const art = resolve(name);
    if (!art) {
      console.log(`# ${name}: (missing)\n`);
      continue;
    }
    const w = Math.max(...art.pixels.map((r) => r.length));
    const used = new Set<string>();
    for (const row of art.pixels) for (const ch of row) if (ch !== ".") used.add(ch);
    const legend = [...used]
      .sort((a, b) => KEY_INDEX[a]! - KEY_INDEX[b]!)
      .map((ch) => {
        const rgba = rgbaOf(art, ch);
        return `${ch}=#${((rgba >>> 8) & 0xffffff).toString(16).padStart(6, "0")}`;
      })
      .join(" ");
    console.log(`# ${name}  ${w}x${art.pixels.length}  ('.' = transparent)`);
    console.log(`# ${legend}`);
    for (const row of art.pixels) console.log(row.padEnd(w, "."));
    console.log("");
  }
  process.exit(0);
}

// ── png mode (single row or contact sheet) ─────────────────────────────────────────
const allCells = grid.rows.flat().filter((n): n is string => !!n);
const arts = new Map(allCells.map((n) => [n, resolve(n)] as const));
const dims = [...arts.values()].filter(Boolean).map((a) => ({ w: Math.max(...a!.pixels.map((r) => r.length)), h: a!.pixels.length }));
const cellW = Math.max(...dims.map((d) => d.w), 1) + PAD * 2;
const cellH = Math.max(...dims.map((d) => d.h), 1) + PAD * 2;

const cols = Math.max(...grid.rows.map((r) => r.length), 1);
const rows = grid.rows.length;
const W = cols * cellW * SCALE;
const H = rows * cellH * SCALE;
const data = blankCanvas(W, H);
const blit = makeBlit(data, W, H);

grid.rows.forEach((row, ri) => {
  row.forEach((name, ci) => {
    const art = name ? arts.get(name) : undefined;
    if (!art) return;
    drawArt(blit, art, ci * cellW + PAD, ri * cellH + PAD);
  });
});

writePng(data, W, H);

// A layout legend on stdout, so the rendered grid is unambiguous when read back.
if (grid.colLabels) console.log(`cols: ${grid.colLabels.join(", ")}`);
if (grid.rowLabels) console.log(`rows: ${grid.rowLabels.join(", ")}`);
if (!grid.colLabels && !grid.rowLabels) console.log(`frames: ${allCells.join(", ")}`);
console.log(`Wrote ${rows}x${cols} grid → /tmp/sprite-preview.png`);
