/**
 * Renders the trogg + Hog sprite sheet to a PNG and an atlas JSON under
 * assets/sprites/. The pixel art itself lives in shared/sprites.ts (pure paint
 * logic); this tool only supplies a surface — an RGBA buffer with alpha
 * blending — and a tiny dependency-free PNG encoder. Run via `pnpm sprites` or
 * `just sprites`; the output is committed so the asset is reviewable without
 * running the generator.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { frames, paintSheet, rgbaSink, SHEET_H, SHEET_W, FRAME_W, FRAME_H, ANCHOR } from "../shared/sprites.ts";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "sprites");
const PNG_PATH = join(OUT_DIR, "troggs-and-hogs.png");
const ATLAS_PATH = join(OUT_DIR, "troggs-and-hogs.atlas.json");

// ── minimal PNG encoder (truecolour + alpha, no filtering) ───────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(typeBytes, 4);
  out.set(body, 8);
  const crcInput = new Uint8Array(4 + body.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(body, 4);
  view.setUint32(8 + body.length, crc32(crcInput));
  return out;
}

function encodePng(data: Uint8Array, w: number, h: number): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // 10..12 = compression / filter / interlace, all 0

  // prefix each scanline with filter byte 0 (none)
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const chunks = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────

const data = new Uint8Array(SHEET_W * SHEET_H * 4); // zeroed = transparent
paintSheet(rgbaSink(data, SHEET_W, SHEET_H));

const png = encodePng(data, SHEET_W, SHEET_H);

const atlas = {
  image: "troggs-and-hogs.png",
  frameWidth: FRAME_W,
  frameHeight: FRAME_H,
  anchor: ANCHOR,
  note: "Avatar base bodies, generated from shared/sprites.ts — run `pnpm sprites` to regenerate.",
  frames: Object.fromEntries(frames().map((f) => [f.name, { x: f.x, y: f.y, w: f.w, h: f.h }])),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(PNG_PATH, png);
writeFileSync(ATLAS_PATH, JSON.stringify(atlas, null, 2) + "\n");

console.log(`Wrote ${SHEET_W}×${SHEET_H} sheet → ${PNG_PATH}`);
console.log(`Wrote atlas (${Object.keys(atlas.frames).length} frames) → ${ATLAS_PATH}`);
