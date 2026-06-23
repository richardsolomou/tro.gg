/**
 * Sprite-sheet generator for troggs and Hogs — programmer pixel art (GDD pillar
 * 5), produced by code so it's reproducible and reviewable as a diff rather than
 * a binary blob dropped in by hand. Run `pnpm sprites` (or `just sprites`).
 *
 * The rig follows GDD "Avatars and equipment": a trogg and a Hog are the SAME
 * rig — same frame box, same anchor, same facings and frames — so equipment will
 * one day render identically on either. Each sheet is laid out as:
 *
 *   rows  = facings: down, up, left, right   (GDD movement directions)
 *   cols  = frames:  idle, walk-a, walk-b    (the idle/walk animation set)
 *
 * Output (served by Vite from `public/` at `/sprites/...`):
 *   public/sprites/troggs.png   4×3 grid of 32×32 frames
 *   public/sprites/hogs.png     same layout, same rig
 *   public/sprites/avatars.json PixiJS-style atlas (frames + animations)
 *
 * Nothing in the running client consumes these yet — placeholder marker
 * rendering still stands (GDD "Placeholder rendering"; avatar art is an open
 * thread, and held-item layers land at M2). This is the asset, ready to wire.
 *
 * Art is built silhouette-first: shapes are filled flat, then a 1px dark outline
 * is grown around the whole silhouette automatically, then face details are
 * painted on top. "right" is the mirror of "left".
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ----------------------------------------------------------------------------
// Rig geometry — shared by troggs and Hogs (GDD: same rig on either).
// ----------------------------------------------------------------------------

const FRAME = 32; // px per frame box; sits over the 28px TILE with headroom.
const FACINGS = ["down", "up", "left", "right"] as const;
const FRAMES = ["idle", "walk-a", "walk-b"] as const;
const BASELINE = 30; // feet rest here; anchor is bottom-centre (16, 30).

type Facing = (typeof FACINGS)[number];
type RGBA = [number, number, number, number];

const CLEAR: RGBA = [0, 0, 0, 0];

// ----------------------------------------------------------------------------
// Palettes — warm, readable tones against the world's dark ground (#0a0806).
// ----------------------------------------------------------------------------

const hex = (n: number, a = 255): RGBA => [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];

const OUTLINE = hex(0x140e09); // near-black brown, the shared outline colour

const TROGG = {
  skin: hex(0x6fae5a), // mossy cave-green
  skinDark: hex(0x4a7c3a),
  skinLight: hex(0x8fce7a),
  eye: hex(0xffd34e), // glowing cave-dweller eyes
  loin: hex(0x8a5a3c), // a scrappy loincloth
  loinDark: hex(0x6a431f),
  tusk: hex(0xe8dcc4), // little cream tusks
};

const HOG = {
  spike: hex(0x966c42), // warm brown quills
  spikeDark: hex(0x6c4c2e),
  spikeLight: hex(0xc49662),
  face: hex(0xf0d8b0), // cream face + belly
  faceDark: hex(0xd4b48c),
  nose: hex(0x281c14),
  eye: hex(0x140e09),
};

// ----------------------------------------------------------------------------
// Tiny pixel canvas.
// ----------------------------------------------------------------------------

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray; // RGBA, row-major

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  px(x: number, y: number, c: RGBA) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = c[3];
  }

  at(x: number, y: number): RGBA {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return CLEAR;
    const i = (y * this.w + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }

  solid(x: number, y: number): boolean {
    return this.at(x, y)[3] > 0;
  }

  rect(x: number, y: number, w: number, h: number, c: RGBA) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.px(xx, yy, c);
  }

  /** Filled ellipse centred on (cx, cy) with radii (rx, ry). */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGBA) {
    for (let yy = Math.ceil(cy - ry); yy <= Math.floor(cy + ry); yy++) {
      for (let xx = Math.ceil(cx - rx); xx <= Math.floor(cx + rx); xx++) {
        const dx = (xx - cx) / rx;
        const dy = (yy - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px(xx, yy, c);
      }
    }
  }

  /**
   * Grow a 1px outline of `col` into every transparent pixel that touches a
   * solid one (4-neighbourhood). Run after the silhouette is filled, before
   * details — this is what gives the art its clean cartoon edge for free.
   */
  outline(col: RGBA) {
    const edges: Array<[number, number]> = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.solid(x, y)) continue;
        if (this.solid(x - 1, y) || this.solid(x + 1, y) || this.solid(x, y - 1) || this.solid(x, y + 1)) {
          edges.push([x, y]);
        }
      }
    }
    for (const [x, y] of edges) this.px(x, y, col);
  }

  /** Blit this canvas into `dest` at (ox, oy), skipping transparent pixels. */
  blit(dest: Canvas, ox: number, oy: number) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const c = this.at(x, y);
        if (c[3] > 0) dest.px(ox + x, oy + y, c);
      }
    }
  }

  /** Horizontal mirror — used to derive "right" from "left". */
  mirrored(): Canvas {
    const out = new Canvas(this.w, this.h);
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) out.px(this.w - 1 - x, y, this.at(x, y));
    }
    return out;
  }
}

// ----------------------------------------------------------------------------
// Walk-cycle parameters per frame.
// ----------------------------------------------------------------------------

interface Gait {
  bob: number; // vertical body bounce (px, negative = up)
  legA: number; // near/left leg phase: + forward/down, - back/up
  legB: number; // far/right leg phase
}

function gait(frame: string): Gait {
  if (frame === "walk-a") return { bob: -1, legA: 2, legB: -2 };
  if (frame === "walk-b") return { bob: -1, legA: -2, legB: 2 };
  return { bob: 0, legA: 0, legB: 0 }; // idle
}

// ----------------------------------------------------------------------------
// Trogg — a chibi cave goblin: big head, pointed ears, glowing eyes, loincloth.
// ----------------------------------------------------------------------------

function drawTrogg(facing: Facing, frame: string): Canvas {
  const c = new Canvas(FRAME, FRAME);
  const g = gait(frame);
  const cx = 16;
  const top = g.bob; // shift the whole upper body for the bounce

  if (facing === "left" || facing === "right") {
    // Profile. Built facing left; "right" mirrors it.
    // Front leg (toward the facing side) is the shaded one; they stride apart.
    legBlock(c, cx - 3 + g.legA, BASELINE, TROGG.skinDark);
    legBlock(c, cx + 2 + g.legB, BASELINE, TROGG.skin);
    // Torso.
    c.ellipse(cx, 21 + top, 5, 5, TROGG.skin);
    c.rect(cx - 5, 22 + top, 10, 3, TROGG.loin); // loincloth band
    // Head, pushed toward the facing side, with a snouty nose.
    c.ellipse(cx - 1, 11 + top, 7, 6, TROGG.skin);
    c.ellipse(cx - 6, 12 + top, 2, 2, TROGG.skinLight); // brow/snout
    c.rect(cx - 8, 12 + top, 2, 2, TROGG.skin); // nose tip
    // One pointed ear sweeping back.
    ear(c, cx + 5, 7 + top, +1, TROGG.skin);
    c.outline(OUTLINE);
    // Eye after outline so it stays bright.
    c.rect(cx - 4, 10 + top, 2, 2, TROGG.eye);
    return facing === "right" ? c.mirrored() : c;
  }

  // Front / back share the silhouette; only details differ.
  // Legs.
  legBlock(c, cx - 4, BASELINE + Math.min(0, g.legA), TROGG.skin, g.legA);
  legBlock(c, cx + 2, BASELINE + Math.min(0, g.legB), TROGG.skin, g.legB);
  // Torso + loincloth.
  c.ellipse(cx, 21 + top, 6, 5, TROGG.skin);
  c.rect(cx - 6, 22 + top, 12, 3, TROGG.loin);
  c.rect(cx - 6, 24 + top, 12, 1, TROGG.loinDark);
  // Arms.
  c.rect(cx - 8, 17 + top, 2, 5, TROGG.skinDark);
  c.rect(cx + 6, 17 + top, 2, 5, TROGG.skinDark);
  // Head.
  c.ellipse(cx, 11 + top, 8, 7, TROGG.skin);
  // Pointed goblin ears.
  ear(c, cx - 7, 6 + top, -1, TROGG.skin);
  ear(c, cx + 7, 6 + top, +1, TROGG.skin);

  c.outline(OUTLINE);

  if (facing === "down") {
    // Glowing eyes + a toothy under-bite.
    c.rect(cx - 4, 10 + top, 2, 2, TROGG.eye);
    c.rect(cx + 2, 10 + top, 2, 2, TROGG.eye);
    c.px(cx - 3, 11 + top, OUTLINE);
    c.px(cx + 3, 11 + top, OUTLINE);
    c.rect(cx - 2, 15 + top, 4, 1, OUTLINE); // mouth line
    c.px(cx - 2, 16 + top, TROGG.tusk); // tusks poking up
    c.px(cx + 1, 16 + top, TROGG.tusk);
  } else {
    // Back of head — a subtle nape shadow at the crown, plus ear-backs. No face.
    c.ellipse(cx, 8 + top, 5, 3, TROGG.skinDark);
    c.px(cx, 12 + top, TROGG.skinDark); // hint of a spine
    c.px(cx, 14 + top, TROGG.skinDark);
  }
  return c;
}

/** A pointed ear: a small triangle leaning in direction `dir` (-1 left, +1 right). */
function ear(c: Canvas, x: number, y: number, dir: number, col: RGBA) {
  for (let i = 0; i < 4; i++) {
    c.rect(x + dir * i, y - i, 2, 2 + i, col);
  }
}

/**
 * A stubby leg/foot rooted at `bottom`. For front/back views pass a `phase`:
 * positive lifts the foot (walk), shortening the leg from below.
 */
function legBlock(c: Canvas, x: number, bottom: number, col: RGBA, phase = 0) {
  const lift = phase > 0 ? phase : 0;
  const h = 5 - lift;
  c.rect(x, bottom - 5, 3, Math.max(2, h), col);
}

// ----------------------------------------------------------------------------
// Hog — a hedgehog: cream face/belly, a quilled back, button nose. Same rig.
// ----------------------------------------------------------------------------

function drawHog(facing: Facing, frame: string): Canvas {
  const c = new Canvas(FRAME, FRAME);
  const g = gait(frame);
  const cx = 16;
  const top = g.bob;

  if (facing === "left" || facing === "right") {
    // Profile, built facing left.
    legBlock(c, cx - 2 + g.legA, BASELINE, HOG.faceDark);
    legBlock(c, cx + 2 + g.legB, BASELINE, HOG.faceDark);
    // Quilled body bulk (back is up-right, away from the face).
    c.ellipse(cx + 1, 18 + top, 8, 8, HOG.spike);
    quillFringe(c, cx + 1, 18 + top, 8, 8, "up");
    // Cream face poking out the front (left).
    c.ellipse(cx - 6, 19 + top, 4, 4, HOG.face);
    c.rect(cx - 11, 19 + top, 2, 2, HOG.face); // snout
    c.outline(OUTLINE);
    c.px(cx - 11, 19 + top, HOG.nose); // nose tip
    c.rect(cx - 7, 17 + top, 2, 2, HOG.eye);
    return facing === "right" ? c.mirrored() : c;
  }

  // Feet peeking under the body.
  legBlock(c, cx - 5, BASELINE + Math.min(0, g.legA), HOG.faceDark, g.legA);
  legBlock(c, cx + 3, BASELINE + Math.min(0, g.legB), HOG.faceDark, g.legB);

  // Round quilled body.
  c.ellipse(cx, 17 + top, 9, 9, HOG.spike);

  if (facing === "down") {
    // Cream face on the lower front, quills crowning the top.
    c.ellipse(cx, 19 + top, 7, 6, HOG.face);
    quillFringe(c, cx, 17 + top, 9, 9, "up");
    quillFringe(c, cx, 17 + top, 9, 9, "side");
    c.outline(OUTLINE);
    // Eyes + button nose + tiny smile.
    c.rect(cx - 4, 17 + top, 2, 2, HOG.eye);
    c.rect(cx + 3, 17 + top, 2, 2, HOG.eye);
    c.rect(cx - 1, 20 + top, 2, 2, HOG.nose);
    c.px(cx - 2, 22 + top, OUTLINE);
    c.px(cx + 1, 22 + top, OUTLINE);
  } else {
    // Back: all quills, a rounded fringe all around.
    c.ellipse(cx, 17 + top, 7, 6, HOG.spikeLight);
    c.ellipse(cx, 16 + top, 6, 4, HOG.spike);
    quillFringe(c, cx, 17 + top, 9, 9, "up");
    quillFringe(c, cx, 17 + top, 9, 9, "side");
    quillRows(c, cx, 12 + top, 17 + top);
    c.outline(OUTLINE);
  }
  return c;
}

/** Triangular quills poking off the rim of an ellipse, either the top or sides. */
function quillFringe(c: Canvas, cx: number, cy: number, rx: number, ry: number, where: "up" | "side") {
  if (where === "up") {
    for (let i = -2; i <= 2; i++) {
      const x = cx + i * 3;
      const len = 3 - Math.abs(i);
      spike(c, x, cy - ry + 1, 0, -1, len, HOG.spikeDark);
    }
  } else {
    spike(c, cx - rx, cy - 2, -1, 0, 3, HOG.spikeDark);
    spike(c, cx + rx - 1, cy - 2, +1, 0, 3, HOG.spikeDark);
    spike(c, cx - rx + 1, cy + 1, -1, 0, 2, HOG.spikeDark);
    spike(c, cx + rx - 2, cy + 1, +1, 0, 2, HOG.spikeDark);
  }
}

/** A couple of interior quill rows to texture the hog's back. */
function quillRows(c: Canvas, cx: number, top: number, bottom: number) {
  for (let y = top; y < bottom; y += 2) {
    for (let x = cx - 5; x <= cx + 5; x += 3) {
      c.px(x, y, HOG.spikeDark);
      c.px(x + 1, y + 1, HOG.spikeDark);
    }
  }
}

/** A single triangular spike growing from (x, y) along (dx, dy). */
function spike(c: Canvas, x: number, y: number, dx: number, dy: number, len: number, col: RGBA) {
  for (let i = 0; i < len; i++) {
    const w = len - i;
    if (dy !== 0) c.rect(x - (w >> 1), y + dy * i, Math.max(1, w), 1, col);
    else c.rect(x + dx * i, y - (w >> 1), 1, Math.max(1, w), col);
  }
}

// ----------------------------------------------------------------------------
// Sheet assembly + atlas.
// ----------------------------------------------------------------------------

interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
}

function buildSheet(draw: (f: Facing, frame: string) => Canvas) {
  const sheet = new Canvas(FRAME * FRAMES.length, FRAME * FACINGS.length);
  const frames: Record<string, AtlasFrame> = {};
  const animations: Record<string, string[]> = {};

  FACINGS.forEach((facing, row) => {
    const names: string[] = [];
    FRAMES.forEach((frameName, col) => {
      const cell = draw(facing, frameName);
      const ox = col * FRAME;
      const oy = row * FRAME;
      cell.blit(sheet, ox, oy);
      const key = `${facing}-${frameName}`;
      frames[key] = { frame: { x: ox, y: oy, w: FRAME, h: FRAME } };
      names.push(key);
    });
    // A bouncy idle→a→idle→b loop for the walk; idle alone for standing.
    animations[`walk-${facing}`] = [`${facing}-idle`, `${facing}-walk-a`, `${facing}-idle`, `${facing}-walk-b`];
    animations[`idle-${facing}`] = [`${facing}-idle`];
  });

  return { sheet, frames, animations };
}

// ----------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, 8-bit, no dependencies).
// ----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(canvas: Canvas): Buffer {
  const { w, h, data } = canvas;
  // Prepend a filter byte (0 = none) to each scanline.
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    data.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
      raw[y * (w * 4 + 1) + 1 + i] = v;
    });
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------------------
// Main.
// ----------------------------------------------------------------------------

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "sprites");
mkdirSync(outDir, { recursive: true });

const trogg = buildSheet(drawTrogg);
const hog = buildSheet(drawHog);

writeFileSync(resolve(outDir, "troggs.png"), encodePng(trogg.sheet));
writeFileSync(resolve(outDir, "hogs.png"), encodePng(hog.sheet));

const atlas = {
  meta: {
    app: "tools/gen-sprites.ts",
    note: "Shared trogg/Hog rig (GDD 'Avatars and equipment'). Anchor is bottom-centre (16,30).",
    frameSize: FRAME,
    anchor: { x: 16, y: BASELINE },
    facings: FACINGS,
    frames: FRAMES,
  },
  sheets: {
    troggs: { image: "troggs.png", frames: trogg.frames, animations: trogg.animations },
    hogs: { image: "hogs.png", frames: hog.frames, animations: hog.animations },
  },
};
writeFileSync(resolve(outDir, "avatars.json"), JSON.stringify(atlas, null, 2) + "\n");

console.log(`Wrote troggs.png, hogs.png, avatars.json to ${outDir}`);
console.log(`  ${FACINGS.length} facings × ${FRAMES.length} frames @ ${FRAME}×${FRAME}px`);
