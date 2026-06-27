import Phaser from "phaser";
import { GLOWMOSS_TILE, GRAVEL_TILE, isWalkable, MOSS_TILE, WALL_TILE, WATER_TILE, type Zone } from "@trogg/shared";

/**
 * Procedural pixel-art terrain for a zone (GDD "Camera and rendering"). The
 * floor and surrounding rock are generated once as small nearest-neighbour
 * textures and tiled, so the screen fills with cave stone instead of flat
 * background. Walls are drawn from the zone's tilemap — the same per-tile
 * walkability `projectMotion` collides against — so what you see is what blocks
 * you. Decorative floor glyphs (gravel, moss, shallow water, glowmoss) paint
 * tile-sized overlays on top of the stone so the cave reads as varied terrain
 * rather than one flat fill; they are cosmetic only and never change collision.
 * Player markers render on top.
 */

/** Art pixels per tile edge — the resolution each tile is drawn at before scaling. */
const ART = 16;
/** Tiles per generated patch; tiling a multi-tile patch hides the repeat. */
const PATCH = 4;

// Cave palette — the torch-lit stone tones shared with the landing page (index.html :root).
const VOID = { base: 0x0a0806, specks: [0x130d07, 0x1b120a] as const };
const FLOOR = { base: 0x342819, light: 0x3f3020, dark: 0x271d12, pebble: 0x4a3826, crack: 0x1c140c, seam: 0x2a2017 };
const WALL = { face: 0x2a2118, top: 0x4a3826, edge: 0x0a0806 };
// Decorative floor variants — overlays painted on top of the stone, mostly
// transparent so the mottled floor shows through and they read as the same
// ground, just dressed (gravel debris, damp moss, a shallow pool, glowmoss).
const GRAVEL = { light: 0x5a4632, mid: 0x4a3826, dark: 0x2f2417 };
const MOSS = { light: 0x4a6b3a, mid: 0x3b5630, dark: 0x263b21 };
const WATER = { deep: 0x12303a, base: 0x1b424f, ripple: 0x2f6675, glint: 0x70502e };
const GLOWMOSS = { core: 0x7ff0d8, mid: 0x3fb6a2, halo: 0x224f48 };

const FLOOR_TEX = "terrain-floor";
const VOID_TEX = "terrain-void";
const VIGNETTE_TEX = "terrain-vignette";
/** Each decorative glyph paints one patch texture, sampled per tile by sub-cell. */
const DECAL_TEX: Record<string, string> = {
  [GRAVEL_TILE]: "decal-gravel",
  [MOSS_TILE]: "decal-moss",
  [WATER_TILE]: "decal-water",
  [GLOWMOSS_TILE]: "decal-glowmoss",
};

export interface Terrain {
  /** Full-viewport rock, drawn in screen space behind the zone. */
  background: Phaser.GameObjects.TileSprite;
  /** Zone floor + wall frame, in zone space (lives in the translated stage). */
  ground: Phaser.GameObjects.Container;
  /** Full-viewport darkening overlay, drawn on top for atmosphere. */
  vignette: Phaser.GameObjects.Image;
  /** Re-lay everything for a tile size and viewport. */
  layout(tile: number, viewW: number, viewH: number): void;
}

export function createTerrain(scene: Phaser.Scene, zone: Zone): Terrain {
  registerTerrainTextures(scene);

  const background = scene.add.tileSprite(0, 0, 1, 1, VOID_TEX).setOrigin(0, 0);
  const floor = scene.add.tileSprite(0, 0, 1, 1, FLOOR_TEX).setOrigin(0, 0);
  const decals = scene.add.container();
  const walls = scene.add.graphics();
  // Decals sit above the floor and below the walls; they only ever cover walkable
  // tiles, so they never overlap the wall faces drawn from `#`.
  const ground = scene.add.container(0, 0, [floor, decals, walls]);
  const vignette = scene.add.image(0, 0, VIGNETTE_TEX).setOrigin(0, 0);

  const layout = (tile: number, viewW: number, viewH: number) => {
    const scale = tile / ART;
    background.setSize(viewW, viewH);
    background.setTileScale(scale);

    floor.setSize(zone.width * tile, zone.height * tile);
    floor.setTileScale(scale);
    drawWalls(walls, zone, tile);
    drawDecals(scene, decals, zone, tile);

    vignette.setDisplaySize(viewW, viewH);
  };

  return { background, ground, vignette, layout };
}

/**
 * Paint every unwalkable tile as beveled stone, reading the zone's tilemap so the
 * walls line up exactly with what blocks movement. A wall face that has floor
 * below it (visible to the 3/4 camera) gets a lit lower edge; one with floor
 * above gets a dark top edge — cheap depth without a spritesheet.
 */
function drawWalls(g: Phaser.GameObjects.Graphics, zone: Zone, tile: number) {
  const px = Math.max(1, Math.round(tile / ART));
  g.clear();

  g.fillStyle(WALL.face, 1);
  for (let ty = 0; ty < zone.height; ty++) {
    for (let tx = 0; tx < zone.width; tx++) {
      if (isWalkable(zone, tx, ty)) continue;
      g.fillRect(tx * tile, ty * tile, tile, tile);
    }
  }
  // Bevels in a second pass so highlights sit on top of neighbouring wall faces.
  for (let ty = 0; ty < zone.height; ty++) {
    for (let tx = 0; tx < zone.width; tx++) {
      if (isWalkable(zone, tx, ty)) continue;
      const x = tx * tile;
      const y = ty * tile;
      if (isWalkable(zone, tx, ty + 1)) g.fillStyle(WALL.top, 1).fillRect(x, y + tile - px * 2, tile, px * 2);
      if (isWalkable(zone, tx, ty - 1)) g.fillStyle(WALL.edge, 1).fillRect(x, y, tile, px);
    }
  }
}

/**
 * Lay a tile-sized image over every decorated floor tile, reading the same
 * tilemap movement collides against. Each glyph picks its prebuilt patch; the
 * tile shows the patch sub-cell at its (x, y) so adjacent same-material tiles
 * (a gravel field, a water pool) flow together. Images are rebuilt per layout
 * because they bake the tile size; old ones are destroyed to avoid leaks.
 */
function drawDecals(scene: Phaser.Scene, layer: Phaser.GameObjects.Container, zone: Zone, tile: number) {
  layer.removeAll(true);
  for (let ty = 0; ty < zone.height; ty++) {
    const row = zone.tiles[ty]!;
    for (let tx = 0; tx < row.length; tx++) {
      const key = DECAL_TEX[row[tx]!];
      if (!key) continue; // plain floor or wall — nothing to overlay
      const cell = `${tx % PATCH}-${ty % PATCH}`;
      const image = scene.add.image(tx * tile, ty * tile, key, cell).setOrigin(0, 0);
      image.setDisplaySize(tile, tile);
      layer.add(image);
    }
  }
}

/** Register every terrain texture once. Patch textures get PATCH×PATCH sub-frames
 *  so a tile can sample the sub-cell matching its coords. Idempotent, so the scene
 *  can call it in `preload` and `createTerrain` re-call is a no-op. */
export function registerTerrainTextures(scene: Phaser.Scene): void {
  addCanvas(scene, FLOOR_TEX, floorPatch());
  addCanvas(scene, VOID_TEX, floorlessPatch(VOID.base, 0.1, VOID.specks));

  for (const [glyph, key] of Object.entries(DECAL_TEX)) {
    const tex = addCanvas(scene, key, decalPatch(glyph));
    if (!tex) continue;
    for (let cy = 0; cy < PATCH; cy++) {
      for (let cx = 0; cx < PATCH; cx++) tex.add(`${cx}-${cy}`, 0, cx * ART, cy * ART, ART, ART);
    }
  }

  // The vignette is a smooth radial gradient, not a tile — keep it linear-filtered
  // so it doesn't show nearest-neighbour banding under the pixel-art default.
  const vignette = addCanvas(scene, VIGNETTE_TEX, vignetteCanvas());
  if (vignette) vignette.setFilter(Phaser.Textures.FilterMode.LINEAR);
}

/** Register a painted canvas as a texture, returning it (null if already present). */
function addCanvas(scene: Phaser.Scene, key: string, canvas: HTMLCanvasElement) {
  if (scene.textures.exists(key)) return null;
  return scene.textures.addCanvas(key, canvas);
}

/** Which painter builds a given decorative glyph's patch. */
function decalPatch(glyph: string): HTMLCanvasElement {
  if (glyph === GRAVEL_TILE) return gravelPatch();
  if (glyph === MOSS_TILE) return mossPatch();
  if (glyph === WATER_TILE) return waterPatch();
  return glowmossPatch();
}

/** Gravel scree: a scatter of light/dark stone chips over the floor. */
function gravelPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x9e3a11);
  return pixelCanvas(size, size, (set) => {
    for (let i = 0; i < size * size * 0.22; i++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const r = rand();
      const col = r < 0.4 ? GRAVEL.light : r < 0.75 ? GRAVEL.mid : GRAVEL.dark;
      set(x, y, col);
      if (rand() < 0.5) set(x + 1, y, col); // occasional 2px chip
    }
  });
}

/** Moss: soft clumps of damp green with darker flecks, leaving stone gaps. */
function mossPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x2c7b3f);
  return pixelCanvas(size, size, (set) => {
    for (let k = 0; k < 26; k++) {
      const cx = Math.floor(rand() * size);
      const cy = Math.floor(rand() * size);
      const r = 1 + Math.floor(rand() * 2);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          if (rand() < 0.25) continue; // ragged edges, not solid blobs
          const t = rand();
          const col = t < 0.15 ? MOSS.dark : t < 0.6 ? MOSS.mid : MOSS.light;
          set(cx + dx, cy + dy, col, 0xe6);
        }
      }
    }
  });
}

/** Shallow water: a near-opaque pool with darker depths and lit ripples. */
function waterPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x1f6fae);
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const col = rand() < 0.3 ? WATER.deep : WATER.base;
        set(x, y, col, 0xea);
      }
    }
    for (let k = 0; k < 60; k++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const len = 1 + Math.floor(rand() * 3);
      for (let s = 0; s < len; s++) set(x + s, y, WATER.ripple, 0xf0);
    }
    for (let k = 0; k < 8; k++) set(Math.floor(rand() * size), Math.floor(rand() * size), WATER.glint, 0xc0);
  });
}

/** Glowmoss: sparse bioluminescent specks with a dim halo, mostly transparent. */
function glowmossPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x33d6c0);
  return pixelCanvas(size, size, (set) => {
    for (let k = 0; k < 22; k++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      set(x, y, GLOWMOSS.halo, 0x66);
      set(x + 1, y, GLOWMOSS.halo, 0x66);
      set(x, y + 1, GLOWMOSS.halo, 0x66);
      set(x + 1, y + 1, GLOWMOSS.halo, 0x66);
      set(x, y, rand() < 0.5 ? GLOWMOSS.core : GLOWMOSS.mid);
    }
  });
}

/**
 * Build a tiling canvas by painting individual art pixels. The painter's `set`
 * takes an optional alpha (0–255, default opaque) so decorative overlays can
 * leave gaps that show the stone floor beneath.
 */
function pixelCanvas(
  w: number,
  h: number,
  paint: (set: (x: number, y: number, color: number, alpha?: number) => void) => void,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  const set = (x: number, y: number, color: number, alpha = 0xff) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = (color >> 16) & 0xff;
    data[i + 1] = (color >> 8) & 0xff;
    data[i + 2] = color & 0xff;
    data[i + 3] = alpha;
  };
  paint(set);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Cave floor: mottled stone, tile seams, a few cracks and pebbles. Deterministic. */
function floorPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xc0ffee);
  return pixelCanvas(size, size, (set) => {
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
function floorlessPatch(base: number, speckChance: number, specks: readonly number[]): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xbadbad);
  return pixelCanvas(size, size, (set) => {
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
function vignetteCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(128, 128, 48, 128, 128, 168);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  return canvas;
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
