import { Container, Graphics, Sprite, Texture, TilingSprite } from "pixi.js";

/**
 * Procedural pixel-art terrain for a zone (GDD "Camera and rendering"). The
 * floor and surrounding rock are generated once as small nearest-neighbour
 * textures and tiled, so the screen fills with cave stone instead of flat
 * background. Purely cosmetic — no walkability or scenery data (that's the
 * deferred tilemap; see GDD data model). Player markers render on top.
 */

/** Art pixels per tile edge — the resolution each tile is drawn at before scaling. */
const ART = 16;
/** Tiles per generated patch; tiling a multi-tile patch hides the repeat. */
const PATCH = 4;

// Cave palette — the torch-lit stone tones shared with the landing page (index.html :root).
const VOID = { base: 0x0a0806, specks: [0x130d07, 0x1b120a] as const };
const FLOOR = { base: 0x342819, light: 0x3f3020, dark: 0x271d12, pebble: 0x4a3826, crack: 0x1c140c, seam: 0x2a2017 };
const WALL = { face: 0x2a2118, top: 0x4a3826, edge: 0x0a0806 };

export interface Terrain {
  /** Full-viewport rock, drawn in screen space behind the zone. */
  background: TilingSprite;
  /** Zone floor + wall frame, in zone space (lives in the translated stage). */
  ground: Container;
  /** Full-viewport darkening overlay, drawn on top for atmosphere. */
  vignette: Sprite;
  /** Re-lay everything for a tile size and viewport. */
  layout(tile: number, viewW: number, viewH: number): void;
}

export function createTerrain(zoneW: number, zoneH: number): Terrain {
  const background = new TilingSprite({ texture: floorlessPatch(VOID.base, 0.1, VOID.specks), width: 1, height: 1 });
  const floor = new TilingSprite({ texture: floorPatch(), width: 1, height: 1 });
  const walls = new Graphics();
  const ground = new Container();
  ground.addChild(floor, walls);
  const vignette = new Sprite(vignetteTexture());

  const layout = (tile: number, viewW: number, viewH: number) => {
    const scale = tile / ART;
    background.width = viewW;
    background.height = viewH;
    background.tileScale.set(scale);

    const w = zoneW * tile;
    const h = zoneH * tile;
    floor.width = w;
    floor.height = h;
    floor.tileScale.set(scale);
    drawWalls(walls, w, h, tile);

    vignette.width = viewW;
    vignette.height = viewH;
  };

  return { background, ground, vignette, layout };
}

/** A beveled stone wall framing the floor — lit inner edge, dark outer edge. */
function drawWalls(g: Graphics, w: number, h: number, tile: number) {
  const t = Math.round(tile * 0.5);
  const px = Math.max(1, Math.round(tile / ART));
  g.clear();
  g.rect(-t, -t, w + 2 * t, t) // top
    .rect(-t, h, w + 2 * t, t) // bottom
    .rect(-t, 0, t, h) // left
    .rect(w, 0, t, h) // right
    .fill(WALL.face);
  g.rect(-t, -t, w + 2 * t, h + 2 * t).stroke({ width: px, color: WALL.edge, alignment: 0 });
  g.rect(0, 0, w, h).stroke({ width: px, color: WALL.top, alignment: 0 });
}

/** Build a tiling texture by painting individual art pixels into a canvas. */
function pixelTexture(w: number, h: number, paint: (set: (x: number, y: number, color: number) => void) => void): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const set = (x: number, y: number, color: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = (color >> 16) & 0xff;
    data[i + 1] = (color >> 8) & 0xff;
    data[i + 2] = color & 0xff;
    data[i + 3] = 0xff;
  };
  paint(set);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/** Cave floor: mottled stone, tile seams, a few cracks and pebbles. Deterministic. */
function floorPatch(): Texture {
  const size = ART * PATCH;
  const rand = rng(0xc0ffee);
  return pixelTexture(size, size, (set) => {
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const r = rand();
        const col = r < 0.12 ? FLOOR.dark : r < 0.24 ? FLOOR.light : FLOOR.base;
        set(x, y, col);
        set(x + 1, y, col);
        set(x, y + 1, col);
        set(x + 1, y + 1, col);
      }
    }
    for (let edge = 0; edge < size; edge += ART) {
      for (let i = 0; i < size; i++) {
        set(edge, i, FLOOR.seam);
        set(i, edge, FLOOR.seam);
      }
    }
    for (let k = 0; k < 3; k++) {
      let cx = 2 + Math.floor(rand() * (size - 4));
      let cy = 2 + Math.floor(rand() * (size - 4));
      const len = 4 + Math.floor(rand() * 6);
      for (let s = 0; s < len; s++) {
        set(cx, cy, FLOOR.crack);
        if (rand() < 0.5) cx++;
        else cy++;
      }
    }
    for (let k = 0; k < 10; k++) {
      const px = Math.floor(rand() * size);
      const py = Math.floor(rand() * size);
      set(px, py, FLOOR.pebble);
      set(px + 1, py, FLOOR.pebble);
      set(px, py + 1, FLOOR.pebble);
    }
  });
}

/** Flat rock fill with sparse darker specks — the void beyond the zone. */
function floorlessPatch(base: number, speckChance: number, specks: readonly number[]): Texture {
  const size = ART * PATCH;
  const rand = rng(0xbadbad);
  return pixelTexture(size, size, (set) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, base);
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        if (rand() >= speckChance) continue;
        const col = specks[Math.floor(rand() * specks.length)]!;
        set(x, y, col);
        set(x + 1, y, col);
        set(x, y + 1, col);
        set(x + 1, y + 1, col);
      }
    }
  });
}

/** Radial darkening, smooth (not pixelated) — a lighting overlay, not a tile. */
function vignetteTexture(): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(128, 128, 48, 128, 128, 168);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return Texture.from(canvas);
}

/** mulberry32 — small deterministic PRNG so terrain looks identical everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
