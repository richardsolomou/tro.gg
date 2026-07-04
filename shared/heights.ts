import { isWalkable, type Zone } from "./constants";

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

function hash01(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth low-frequency noise: bilinear over a hashed lattice at `scale` tiles. */
export function rangeNoise(x: number, y: number, scale: number, salt: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash01(x0, y0, salt) * (1 - sx) + hash01(x0 + 1, y0, salt) * sx;
  const bot = hash01(x0, y0 + 1, salt) * (1 - sx) + hash01(x0 + 1, y0 + 1, salt) * sx;
  return top * (1 - sy) + bot * sy;
}

/** Multi-source BFS from every walkable tile: how deep into rock each tile sits. */
function rockDepthField(zone: Zone): Uint8Array {
  const depth = new Uint8Array(zone.width * zone.height).fill(255);
  const queue: number[] = [];
  for (let y = 0; y < zone.height; y++) {
    for (let x = 0; x < zone.width; x++) {
      if (isWalkable(zone, x, y)) {
        depth[y * zone.width + x] = 0;
        queue.push(y * zone.width + x);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    const x = at % zone.width;
    const y = (at - x) / zone.width;
    const next = depth[at]! + 1;
    if (next > 8) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= zone.width || ny >= zone.height) continue;
      const ni = ny * zone.width + nx;
      if (depth[ni]! <= next) continue;
      depth[ni] = next;
      queue.push(ni);
    }
  }
  return depth;
}

const depthCache = new WeakMap<Zone, Uint8Array>();

/** A wall tile's rendered rock height, in tiles. Deterministic; the one-time
 *  depth field is cached per zone. */
export function rockHeightAt(zone: Zone, x: number, y: number): number {
  let field = depthCache.get(zone);
  if (!field) {
    field = rockDepthField(zone);
    depthCache.set(zone, field);
  }
  const depth = Math.min(8, field[y * zone.width + x] ?? 1);
  const range = 0.7 + rangeNoise(x, y, 14, 0x9e3779b1) * 0.75; // ranges swell and dip
  const jitter = 0.9 + hash01(x, y, 0x2545f491) * 0.2; // per-tile roughness
  let height = (ROCK_EDGE + Math.max(0, depth - 1) * ROCK_PER_DEPTH) * range * jitter;
  // occasional summits spike out of high cores
  if (depth >= 3 && rangeNoise(x, y, 7, 0x85eb ^ depth) > 0.82) height += 2.2;
  return Math.min(ROCK_CAP, Math.max(1.1, height));
}
