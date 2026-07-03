import * as THREE from "three";
import { GLOWMOSS_TILE, GRAVEL_TILE, isWalkable, MOSS_TILE, WATER_TILE, type Zone } from "@trogg/shared";
import { CAVE_3D } from "./palette.js";

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
  dispose(): void;
}

export function buildTerrain(zone: Zone): Terrain3D {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  const patchTexture = (canvas: HTMLCanvasElement, repeatX: number, repeatY: number): THREE.CanvasTexture => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatY);
    disposables.push(tex);
    return tex;
  };

  // Zone floor, centred so tile (x, y) spans [x, x+1) on world x/z.
  const floorTex = patchTexture(floorPatch(), zone.width / PATCH, zone.height / PATCH);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(zone.width, zone.height), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(zone.width / 2, 0, zone.height / 2);
  floor.receiveShadow = true;
  group.add(floor);

  // The void beyond the zone: a big dim rock plane just below the floor.
  const voidTex = patchTexture(floorlessPatch(), 200 / PATCH, 200 / PATCH);
  const voidPlane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ map: voidTex, roughness: 1 }));
  voidPlane.rotation.x = -Math.PI / 2;
  voidPlane.position.set(zone.width / 2, -0.02, zone.height / 2);
  voidPlane.receiveShadow = true;
  group.add(voidPlane);

  // Walls: one instanced beveled block per unwalkable tile — lit top, dark-edged
  // faces — in a single draw call however large the cave grows.
  const face = new THREE.MeshStandardMaterial({ color: CAVE_3D.wall.face, roughness: 1 });
  const top = new THREE.MeshStandardMaterial({ color: CAVE_3D.wall.top, roughness: 1 });
  const wallMats = [face, face, top, face, face, face];
  const wallGeo = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
  disposables.push(face, top, wallGeo);
  const wallTiles: { x: number; y: number }[] = [];
  for (let ty = 0; ty < zone.height; ty++) {
    for (let tx = 0; tx < zone.width; tx++) {
      if (!isWalkable(zone, tx, ty)) wallTiles.push({ x: tx, y: ty });
    }
  }
  const walls = new THREE.InstancedMesh(wallGeo, wallMats, wallTiles.length);
  const place = new THREE.Matrix4();
  wallTiles.forEach((tile, i) => {
    place.makeTranslation(tile.x + 0.5, WALL_HEIGHT / 2, tile.y + 0.5);
    walls.setMatrixAt(i, place);
  });
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // Floor variants: every decorated tile is blitted from its patch's matching
  // sub-cell into one zone-sized overlay canvas — a single transparent plane
  // instead of a quad and material per tile.
  const decalCanvases: Record<string, HTMLCanvasElement> = {
    [GRAVEL_TILE]: gravelPatch(),
    [MOSS_TILE]: mossPatch(),
    [WATER_TILE]: waterPatch(),
    [GLOWMOSS_TILE]: glowmossPatch(),
  };
  const overlay = document.createElement("canvas");
  overlay.width = zone.width * ART;
  overlay.height = zone.height * ART;
  const octx = overlay.getContext("2d")!;
  const glowTiles: { x: number; y: number }[] = [];
  for (let ty = 0; ty < zone.height; ty++) {
    const row = zone.tiles[ty]!;
    for (let tx = 0; tx < row.length; tx++) {
      const glyph = row[tx]!;
      const canvas = decalCanvases[glyph];
      if (!canvas) continue;
      octx.drawImage(canvas, (tx % PATCH) * ART, (ty % PATCH) * ART, ART, ART, tx * ART, ty * ART, ART, ART);
      if (glyph === GLOWMOSS_TILE) glowTiles.push({ x: tx, y: ty });
    }
  }
  const overlayTex = patchTexture(overlay, 1, 1);
  overlayTex.repeat.set(1, 1);
  const overlayMat = new THREE.MeshStandardMaterial({ map: overlayTex, transparent: true, roughness: 1 });
  disposables.push(overlayMat);
  const overlayQuad = new THREE.Mesh(new THREE.PlaneGeometry(zone.width, zone.height), overlayMat);
  overlayQuad.rotation.x = -Math.PI / 2;
  overlayQuad.position.set(zone.width / 2, 0.01, zone.height / 2);
  overlayQuad.receiveShadow = true;
  group.add(overlayQuad);

  // Glowmoss lights: one per patch of moss, not per tile — greedy-clustered by
  // proximity and capped, so the light count stays renderer-friendly.
  const clusters: { x: number; y: number; count: number }[] = [];
  for (const tile of glowTiles) {
    const near = clusters.find((c) => Math.abs(c.x - tile.x) + Math.abs(c.y - tile.y) <= 5);
    if (near) near.count++;
    else clusters.push({ x: tile.x, y: tile.y, count: 1 });
  }
  for (const cluster of clusters.slice(0, 12)) {
    const glow = new THREE.PointLight(CAVE_3D.glowmoss.mid, 1.2 + Math.min(cluster.count, 3) * 0.3, 5);
    glow.position.set(cluster.x + 0.5, 0.5, cluster.y + 0.5);
    group.add(glow);
  }

  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
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
function floorPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xc0ffee);
  const F = CAVE_3D.floor;
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
function floorlessPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0xbadbad);
  return pixelCanvas(size, size, (set) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, CAVE_3D.voidBase);
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        if (rand() >= 0.1) continue;
        const col = CAVE_3D.voidSpecks[Math.floor(rand() * CAVE_3D.voidSpecks.length)]!;
        set(x, y, col);
        set(x + 1, y, col);
        set(x, y + 1, col);
        set(x + 1, y + 1, col);
      }
    }
  });
}

/** Gravel scree: a scatter of light/dark stone chips over the floor. */
function gravelPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x9e3a11);
  const G = CAVE_3D.gravel;
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
function mossPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x2c7b3f);
  const M = CAVE_3D.moss;
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
function waterPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x1f6fae);
  const W = CAVE_3D.water;
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
function glowmossPatch(): HTMLCanvasElement {
  const size = ART * PATCH;
  const rand = rng(0x33d6c0);
  const G = CAVE_3D.glowmoss;
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
