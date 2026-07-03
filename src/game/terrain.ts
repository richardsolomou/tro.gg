import * as THREE from "three";
import { GLOWMOSS_TILE, GRAVEL_TILE, MOSS_TILE, regionAt, WALL_TILE, WATER_TILE, type Zone } from "@trogg/shared";
import { biomePalette } from "./palette.js";

/**
 * Procedural cave terrain. The floor and void are pixel-painted patch
 * textures (nearest-filtered, so the cave stays chunky); walls are read from the
 * same tilemap movement collides against, so what you see is exactly what blocks
 * you — drawn as ONE instanced mesh, so a generated 64×44 world costs the same
 * draw calls as the old hand-carved room. Decorative floor variants (gravel,
 * moss, water, glowmoss) are baked into a single zone-sized overlay texture
 * instead of per-tile quads; glowmoss point lights are clustered and capped so
 * the forward renderer never sees more than a dozen.
 */

/** Texels per tile edge of the painted patch textures. */
const ART = 16;
/** Tiles per generated patch; tiling a multi-tile patch hides the repeat. */
const PATCH = 4;
const WALL_HEIGHT = 0.85;

export interface Terrain3D {
  group: THREE.Group;
  /** Stream chunks around the camera focus; call once per frame. */
  update(focusX: number, focusY: number, camDistance: number): void;
  dispose(): void;
}

/** Tiles per streamed chunk (a region is 64×44, so seams stay region-aligned on x). */
const CHUNK = 32;

export function buildTerrain(zone: Zone): Terrain3D {
  const group = new THREE.Group();
  const globalDisposables: { dispose(): void }[] = [];

  // Painter caches: each biome paints its patch canvases once; every chunk of
  // that biome blits from the shared canvases.
  const patchCache = new Map<string, Record<string, HTMLCanvasElement>>();
  const patchesFor = (biome: string): Record<string, HTMLCanvasElement> => {
    let entry = patchCache.get(biome);
    if (!entry) {
      const pal = biomePalette(biome);
      entry = {
        floor: floorPatch(pal),
        [GRAVEL_TILE]: gravelPatch(pal),
        [MOSS_TILE]: mossPatch(pal),
        [WATER_TILE]: waterPatch(pal),
        [GLOWMOSS_TILE]: glowmossPatch(pal),
      };
      patchCache.set(biome, entry);
    }
    return entry;
  };
  const tileBiome = (x: number, y: number): string => regionAt(x, y)?.biome ?? "cave";

  // The void beyond and beneath the world: one dim rock plane.
  const cavePal = biomePalette("cave");
  const voidTex = new THREE.CanvasTexture(floorlessPatch(cavePal));
  voidTex.colorSpace = THREE.SRGBColorSpace;
  voidTex.magFilter = THREE.NearestFilter;
  voidTex.minFilter = THREE.NearestFilter;
  voidTex.wrapS = THREE.RepeatWrapping;
  voidTex.wrapT = THREE.RepeatWrapping;
  voidTex.repeat.set(600 / PATCH, 600 / PATCH);
  globalDisposables.push(voidTex);
  const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: voidTex, roughness: 1 }));
  voidPlane.rotation.x = -Math.PI / 2;
  voidPlane.position.set(zone.width / 2, -0.02, zone.height / 2);
  voidPlane.receiveShadow = true;
  group.add(voidPlane);

  // Walls tint per tile through instance colours, so biome borders stay
  // tile-exact even when a chunk straddles two regions.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const wallGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
  globalDisposables.push(wallMat, wallGeo);

  interface BuiltChunk {
    group: THREE.Group;
    disposables: { dispose(): void }[];
  }
  const chunks = new Map<string, BuiltChunk>();
  const wallColour = new THREE.Color();

  const buildChunk = (cx: number, cy: number): BuiltChunk | undefined => {
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const w = Math.min(CHUNK, zone.width - x0);
    const h = Math.min(CHUNK, zone.height - y0);
    if (w <= 0 || h <= 0) return undefined;

    const chunkGroup = new THREE.Group();
    const disposables: { dispose(): void }[] = [];

    // Floor: one canvas per chunk, each tile blitted from its biome's patch at
    // the world-aligned sub-cell so seams between chunks and regions vanish.
    const canvas = document.createElement("canvas");
    canvas.width = w * ART;
    canvas.height = h * ART;
    const ctx = canvas.getContext("2d")!;
    const wallTiles: { x: number; y: number; biome: string }[] = [];
    const glowTiles: { x: number; y: number; biome: string }[] = [];
    for (let y = 0; y < h; y++) {
      const row = zone.tiles[y0 + y]!;
      for (let x = 0; x < w; x++) {
        const wx = x0 + x;
        const wy = y0 + y;
        const glyph = row[wx]!;
        const biome = tileBiome(wx, wy);
        const patches = patchesFor(biome);
        const sx = (wx % PATCH) * ART;
        const sy = (wy % PATCH) * ART;
        ctx.drawImage(patches.floor!, sx, sy, ART, ART, x * ART, y * ART, ART, ART);
        if (glyph === WALL_TILE) {
          wallTiles.push({ x: wx, y: wy, biome });
          continue;
        }
        const decal = patches[glyph];
        if (decal) ctx.drawImage(decal, sx, sy, ART, ART, x * ART, y * ART, ART, ART);
        if (glyph === GLOWMOSS_TILE) glowTiles.push({ x: wx, y: wy, biome });
      }
    }
    const floorTex = new THREE.CanvasTexture(canvas);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    floorTex.magFilter = THREE.NearestFilter;
    floorTex.minFilter = THREE.NearestFilter;
    disposables.push(floorTex);
    const floorMat = new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1 });
    disposables.push(floorMat);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, h), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(x0 + w / 2, 0, y0 + h / 2);
    floor.receiveShadow = true;
    chunkGroup.add(floor);

    if (wallTiles.length > 0) {
      const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallTiles.length);
      const place = new THREE.Matrix4();
      wallTiles.forEach((tile, i) => {
        place.makeTranslation(tile.x + 0.5, WALL_HEIGHT / 2, tile.y + 0.5);
        walls.setMatrixAt(i, place);
        walls.setColorAt(i, wallColour.setHex(biomePalette(tile.biome).wall.face));
      });
      walls.castShadow = true;
      walls.receiveShadow = true;
      chunkGroup.add(walls);
      disposables.push(walls);
    }

    // Glowmoss: one light per moss patch, at most two per chunk.
    const clusters: { x: number; y: number; count: number; biome: string }[] = [];
    for (const tile of glowTiles) {
      const near = clusters.find((c) => Math.abs(c.x - tile.x) + Math.abs(c.y - tile.y) <= 5);
      if (near) near.count++;
      else clusters.push({ ...tile, count: 1 });
    }
    for (const cluster of clusters.slice(0, 2)) {
      const glow = new THREE.PointLight(biomePalette(cluster.biome).glowmoss.mid, 1.2 + Math.min(cluster.count, 3) * 0.3, 5);
      glow.position.set(cluster.x + 0.5, 0.5, cluster.y + 0.5);
      chunkGroup.add(glow);
    }

    group.add(chunkGroup);
    return { group: chunkGroup, disposables };
  };

  const dropChunk = (key: string) => {
    const chunk = chunks.get(key);
    if (!chunk) return;
    chunks.delete(key);
    group.remove(chunk.group);
    for (const d of chunk.disposables) d.dispose();
  };

  const update = (focusX: number, focusY: number, camDistance: number) => {
    // The streamed radius follows the zoom, Google-Maps style: close in you get
    // the neighbourhood, zoomed out the chunks fan out to what the fog reveals.
    const radius = Math.min(320, Math.max(48, camDistance * 2.6 + 40));
    const c0x = Math.floor((focusX - radius) / CHUNK);
    const c1x = Math.floor((focusX + radius) / CHUNK);
    const c0y = Math.floor((focusY - radius) / CHUNK);
    const c1y = Math.floor((focusY + radius) / CHUNK);
    const maxCx = Math.ceil(zone.width / CHUNK) - 1;
    const maxCy = Math.ceil(zone.height / CHUNK) - 1;
    const wanted: { cx: number; cy: number; dist: number }[] = [];
    for (let cy = Math.max(0, c0y); cy <= Math.min(maxCy, c1y); cy++) {
      for (let cx = Math.max(0, c0x); cx <= Math.min(maxCx, c1x); cx++) {
        const centreX = cx * CHUNK + CHUNK / 2;
        const centreY = cy * CHUNK + CHUNK / 2;
        const dist = Math.hypot(centreX - focusX, centreY - focusY);
        if (dist <= radius + CHUNK) wanted.push({ cx, cy, dist });
      }
    }
    // build nearest-first, at most two per frame so streaming never hitches
    wanted.sort((a, b) => a.dist - b.dist);
    let built = 0;
    const keep = new Set<string>();
    for (const want of wanted) {
      const key = `${want.cx},${want.cy}`;
      keep.add(key);
      if (!chunks.has(key) && built < 2) {
        const chunk = buildChunk(want.cx, want.cy);
        if (chunk) chunks.set(key, chunk);
        built++;
      }
    }
    // drop chunks that fell out of range (with hysteresis so edges don't thrash)
    for (const key of [...chunks.keys()]) {
      if (keep.has(key)) continue;
      const [cx, cy] = key.split(",").map(Number);
      const dist = Math.hypot(cx! * CHUNK + CHUNK / 2 - focusX, cy! * CHUNK + CHUNK / 2 - focusY);
      if (dist > radius + CHUNK * 2) dropChunk(key);
    }
  };

  return {
    group,
    update,
    dispose() {
      for (const key of [...chunks.keys()]) dropChunk(key);
      for (const d of globalDisposables) d.dispose();
    },
  };
}

// ── pixel painters — the cave's procedural patch textures ───────────────────────

function pixelCanvas(w: number, h: number, paint: (set: (x: number, y: number, color: number, alpha?: number) => void) => void): HTMLCanvasElement {
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
function floorPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xc0ffee);
  const F = pal.floor;
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const r = rand();
        const col = r < 0.12 ? F.dark : r < 0.24 ? F.light : F.base;
        set(x, y, col);
        set(x + 1, y, col);
        set(x, y + 1, col);
        set(x + 1, y + 1, col);
      }
    }
    for (let edge = 0; edge < size; edge += ART) {
      for (let i = 0; i < size; i++) {
        set(edge, i, F.seam);
        set(i, edge, F.seam);
      }
    }
    for (let k = 0; k < 3; k++) {
      let cx = 2 + Math.floor(rand() * (size - 4));
      let cy = 2 + Math.floor(rand() * (size - 4));
      const len = 4 + Math.floor(rand() * 6);
      for (let s = 0; s < len; s++) {
        set(cx, cy, F.crack);
        if (rand() < 0.5) cx++;
        else cy++;
      }
    }
    for (let k = 0; k < 10; k++) {
      const px = Math.floor(rand() * size);
      const py = Math.floor(rand() * size);
      set(px, py, F.pebble);
      set(px + 1, py, F.pebble);
      set(px, py + 1, F.pebble);
    }
  });
}

/** Flat rock fill with sparse darker specks — the void beyond the zone. */
function floorlessPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xbadbad);
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, pal.voidBase);
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        if (rand() >= 0.1) continue;
        const col = pal.voidSpecks[Math.floor(rand() * pal.voidSpecks.length)]!;
        set(x, y, col);
        set(x + 1, y, col);
        set(x, y + 1, col);
        set(x + 1, y + 1, col);
      }
    }
  });
}

/** Gravel scree: a scatter of light/dark stone chips over the floor. */
function gravelPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x9e3a11);
  const G = pal.gravel;
  return pixelCanvas(size, size, (set) => {
    for (let i = 0; i < size * size * 0.22; i++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const r = rand();
      const col = r < 0.4 ? G.light : r < 0.75 ? G.mid : G.dark;
      set(x, y, col);
      if (rand() < 0.5) set(x + 1, y, col);
    }
  });
}

/** Moss: soft clumps of damp green with darker flecks, leaving stone gaps. */
function mossPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x2c7b3f);
  const M = pal.moss;
  return pixelCanvas(size, size, (set) => {
    for (let k = 0; k < 26; k++) {
      const cx = Math.floor(rand() * size);
      const cy = Math.floor(rand() * size);
      const r = 1 + Math.floor(rand() * 2);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          if (rand() < 0.25) continue;
          const t = rand();
          const col = t < 0.15 ? M.dark : t < 0.6 ? M.mid : M.light;
          set(cx + dx, cy + dy, col, 0xe6);
        }
      }
    }
  });
}

/** Shallow water: a near-opaque pool with darker depths and lit ripples. */
function waterPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x1f6fae);
  const W = pal.water;
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) set(x, y, rand() < 0.3 ? W.deep : W.base, 0xea);
    }
    for (let k = 0; k < 60; k++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      const len = 1 + Math.floor(rand() * 3);
      for (let s = 0; s < len; s++) set(x + s, y, W.ripple, 0xf0);
    }
    for (let k = 0; k < 8; k++) set(Math.floor(rand() * size), Math.floor(rand() * size), W.glint, 0xc0);
  });
}

/** Glowmoss: sparse bioluminescent specks with a dim halo, mostly transparent. */
function glowmossPatch(pal: ReturnType<typeof biomePalette>): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x33d6c0);
  const G = pal.glowmoss;
  return pixelCanvas(size, size, (set) => {
    for (let k = 0; k < 22; k++) {
      const x = Math.floor(rand() * size);
      const y = Math.floor(rand() * size);
      set(x, y, G.halo, 0x66);
      set(x + 1, y, G.halo, 0x66);
      set(x, y + 1, G.halo, 0x66);
      set(x + 1, y + 1, G.halo, 0x66);
      set(x, y, rand() < 0.5 ? G.core : G.mid);
    }
  });
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
