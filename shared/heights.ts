import { isWalkable, type Zone } from "./constants";
import { rangeNoise } from "./worldgen";

/**
 * The rock skyline, shared. Wall tiles render at a terrain-shaped height
 * (`src/game/terrain.ts` draws these exact values): a distance field from the
 * walkable floor keeps rock beside paths at shoulder height and raises
 * formation cores into mountains, with low-frequency noise and occasional
 * summits. The fly cheat's clearance reads the same function, so "just above
 * the rock you can see" is exactly what the projection lets you cross —
 * deterministic on every client and the server (invariant 3).
 */

const ROCK_EDGE = 1.3;
const ROCK_PER_DEPTH = 1.5;
const ROCK_CAP = 9;
const DEPTH_CAP = 8;

function hash01(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** BFS how deep into rock each tile of `[x0, x0+w) × [y0, y0+h)` sits, seeded
 *  from every walkable tile in the window. Depth saturates at DEPTH_CAP, so a
 *  window with a DEPTH_CAP-tile halo gives exact values for its interior. */
function depthWindow(zone: Zone, x0: number, y0: number, w: number, h: number): Uint8Array {
  const depth = new Uint8Array(w * h).fill(255);
  const queue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isWalkable(zone, x0 + x, y0 + y)) {
        depth[y * w + x] = 0;
        queue.push(y * w + x);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    const x = at % w;
    const y = (at - x) / w;
    const next = depth[at]! + 1;
    if (next > DEPTH_CAP) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (depth[ni]! <= next) continue;
      depth[ni] = next;
      queue.push(ni);
    }
  }
  return depth;
}

// Bounded zones compute their whole field once; the unbounded world computes
// chunk windows with a DEPTH_CAP halo on demand — every interior value exact
// regardless of which chunk asked — and caches them FIFO.
const DEPTH_CHUNK = 32;
const DEPTH_CHUNK_CACHE_MAX = 512;
const boundedCache = new WeakMap<Zone, Uint8Array>();
const chunkedCache = new WeakMap<Zone, Map<string, Uint8Array>>();

function rockDepthAt(zone: Zone, x: number, y: number): number {
  if (!zone.unbounded) {
    let field = boundedCache.get(zone);
    if (!field) {
      field = depthWindow(zone, 0, 0, zone.width, zone.height);
      boundedCache.set(zone, field);
    }
    return field[y * zone.width + x] ?? 1;
  }
  const cx = Math.floor(x / DEPTH_CHUNK);
  const cy = Math.floor(y / DEPTH_CHUNK);
  let chunks = chunkedCache.get(zone);
  if (!chunks) {
    chunks = new Map();
    chunkedCache.set(zone, chunks);
  }
  const key = `${cx},${cy}`;
  let chunk = chunks.get(key);
  if (!chunk) {
    const span = DEPTH_CHUNK + DEPTH_CAP * 2;
    const window = depthWindow(zone, cx * DEPTH_CHUNK - DEPTH_CAP, cy * DEPTH_CHUNK - DEPTH_CAP, span, span);
    chunk = new Uint8Array(DEPTH_CHUNK * DEPTH_CHUNK);
    for (let dy = 0; dy < DEPTH_CHUNK; dy++) {
      for (let dx = 0; dx < DEPTH_CHUNK; dx++) {
        chunk[dy * DEPTH_CHUNK + dx] = window[(dy + DEPTH_CAP) * span + dx + DEPTH_CAP]!;
      }
    }
    if (chunks.size >= DEPTH_CHUNK_CACHE_MAX) {
      let drop = chunks.size - DEPTH_CHUNK_CACHE_MAX + 1;
      for (const staleKey of chunks.keys()) {
        if (drop-- <= 0) break;
        chunks.delete(staleKey);
      }
    }
    chunks.set(key, chunk);
  }
  return chunk[(y - cy * DEPTH_CHUNK) * DEPTH_CHUNK + (x - cx * DEPTH_CHUNK)] ?? 1;
}

/** A wall tile's rendered rock height, in tiles. Deterministic; depth fields
 *  are cached per zone (whole-zone when bounded, chunked when not). */
export function rockHeightAt(zone: Zone, x: number, y: number): number {
  const depth = Math.min(DEPTH_CAP, rockDepthAt(zone, x, y));
  const range = 0.7 + rangeNoise(x, y, 14, 0x9e3779b1) * 0.75; // ranges swell and dip
  const jitter = 0.9 + hash01(x, y, 0x2545f491) * 0.2; // per-tile roughness
  let height = (ROCK_EDGE + Math.max(0, depth - 1) * ROCK_PER_DEPTH) * range * jitter;
  // occasional summits spike out of high cores
  if (depth >= 3 && rangeNoise(x, y, 7, 0x85eb ^ depth) > 0.82) height += 2.2;
  return Math.min(ROCK_CAP, Math.max(1.1, height));
}
