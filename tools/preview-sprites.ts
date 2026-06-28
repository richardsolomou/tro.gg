/**
 * Dev-only: renders chosen frames upscaled onto a grey backdrop so the art is
 * legible when eyeballing it (the committed sheet is tiny). Not committed art —
 * writes to /tmp. Names resolve to avatar frames, "ghost", or item-art props.
 * Usage: `tsx tools/preview-sprites.ts <name> [name...]`.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { AVATAR_FRAME_ART, GHOST_ART, PIXEL_KEYS, type IndexedSpriteArt } from "../shared/sprite_art.ts";
import { ITEM_ART } from "../shared/item_art.ts";

const SCALE = 7;
const PAD = 2;
const KEY_INDEX: Record<string, number> = Object.fromEntries([...PIXEL_KEYS].map((k, i) => [k, i]));

function resolve(name: string): IndexedSpriteArt {
  if (name === "ghost") return GHOST_ART;
  return AVATAR_FRAME_ART[name] ?? ITEM_ART[name]!;
}

const names = process.argv.slice(2);
const arts = names.map(resolve);
const dims = arts.map((a) => ({ w: Math.max(...a.pixels.map((r) => r.length)), h: a.pixels.length }));
const cellW = Math.max(...dims.map((d) => d.w)) + PAD * 2;
const cellH = Math.max(...dims.map((d) => d.h)) + PAD * 2;

const cols = arts.length;
const W = cols * cellW * SCALE;
const H = cellH * SCALE;
const data = new Uint8Array(W * H * 4);

function put(x: number, y: number, r: number, g: number, b: number, a: number) {
  for (let sy = 0; sy < SCALE; sy++)
    for (let sx = 0; sx < SCALE; sx++) {
      const px = x * SCALE + sx;
      const py = y * SCALE + sy;
      const i = (py * W + px) * 4;
      const da = data[i + 3]! / 255;
      const saf = a / 255;
      const oa = saf + da * (1 - saf);
      const bl = (s: number, d: number) => (oa === 0 ? 0 : Math.round((s * saf + d * da * (1 - saf)) / oa));
      data[i] = bl(r, data[i]!);
      data[i + 1] = bl(g, data[i + 1]!);
      data[i + 2] = bl(b, data[i + 2]!);
      data[i + 3] = Math.round(oa * 255);
    }
}

for (let y = 0; y < H / SCALE; y++)
  for (let x = 0; x < W / SCALE; x++) {
    const c = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 0x88 : 0x70;
    put(x, y, c, c, c, 255);
  }

arts.forEach((art, ci) => {
  for (let y = 0; y < art.pixels.length; y++) {
    const row = art.pixels[y] ?? "";
    for (let x = 0; x < row.length; x++) {
      const k = row[x] ?? ".";
      if (k === ".") continue;
      const rgba = art.palette[KEY_INDEX[k]!]!;
      const r = Math.floor(rgba / 0x1000000) & 0xff;
      const g = Math.floor(rgba / 0x10000) & 0xff;
      const b = Math.floor(rgba / 0x100) & 0xff;
      const a = rgba & 0xff;
      put(ci * cellW + PAD + x, PAD + y, r, g, b, a);
    }
  }
});

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, body: Uint8Array) { const tb = new Uint8Array([...type].map((ch) => ch.charCodeAt(0))); const out = new Uint8Array(12 + body.length); const v = new DataView(out.buffer); v.setUint32(0, body.length); out.set(tb, 4); out.set(body, 8); const ci = new Uint8Array(4 + body.length); ci.set(tb, 0); ci.set(body, 4); v.setUint32(8 + body.length, crc32(ci)); return out; }
const ihdr = new Uint8Array(13); const iv = new DataView(ihdr.buffer); iv.setUint32(0, W); iv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 6;
const raw = new Uint8Array(H * (1 + W * 4));
for (let y = 0; y < H; y++) { raw[y * (1 + W * 4)] = 0; raw.set(data.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1); }
const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunks = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0))];
const total = chunks.reduce((n, c) => n + c.length, 0);
const png = new Uint8Array(total); let off = 0; for (const c of chunks) { png.set(c, off); off += c.length; }
writeFileSync("/tmp/sprite-preview.png", png);
console.log(`Wrote ${cols} frames → /tmp/sprite-preview.png`);
