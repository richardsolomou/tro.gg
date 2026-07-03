import { GLOWMOSS_TILE, GRAVEL_TILE, MOSS_TILE, WALL_TILE, WATER_TILE } from "./glyphs";
import type { BigHog, Coord, GroundItemSeed, Zone } from "./constants";

/**
 * Deterministic cave generation (GDD "Zones"). A zone is grown from a fixed seed
 * with pure integer/float arithmetic (mulberry32, no `Math.random`), so the
 * client and the SpacetimeDB module derive the *identical* tilemap from the same
 * registry entry — the world stays shared static design data, just authored by
 * code instead of by hand. Guarantees, enforced by tests:
 *
 * - a solid one-tile wall rim (out-of-bounds is unwalkable anyway);
 * - a clear spawn plaza around the zone centre (`spawnAt` is the centre tile);
 * - every walkable tile reachable from the spawn (disconnected pockets are
 *   filled back in), so click-to-move can route anywhere you can see;
 * - seeded boulders, roaming hogs, starter tools, and the two showpiece giants
 *   all land on open floor, giants on clear 2×2 footprints.
 */

/** How much of the interior starts as rock before smoothing. */
const FILL = 0.44;
/** Cellular-automata smoothing passes: a tile becomes rock when its 3×3
 *  neighbourhood holds five or more rocks. */
const SMOOTH_PASSES = 5;
/** Radius of the guaranteed-open spawn plaza at the zone centre. */
const SPAWN_CLEARING = 3;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CaveOptions {
  slug: string;
  name: string;
  width: number;
  height: number;
  seed: number;
  boulders: number;
  hogs: number;
}

export function generateCaveZone(opts: CaveOptions): Zone {
  const { width, height, seed } = opts;
  const rand = mulberry32(seed);
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const idx = (x: number, y: number) => y * width + x;

  // ── carve the cave ────────────────────────────────────────────────────────────
  let rock = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rim = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      rock[idx(x, y)] = rim || rand() < FILL ? 1 : 0;
    }
  }
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Uint8Array(rock);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)]!;
        next[idx(x, y)] = n >= 5 ? 1 : 0;
      }
    }
    rock = next;
  }
  // the spawn plaza stays open no matter what the automaton grew there
  for (let dy = -SPAWN_CLEARING; dy <= SPAWN_CLEARING; dy++) {
    for (let dx = -SPAWN_CLEARING; dx <= SPAWN_CLEARING; dx++) {
      if (dx * dx + dy * dy <= SPAWN_CLEARING * SPAWN_CLEARING) rock[idx(cx + dx, cy + dy)] = 0;
    }
  }
  // keep only the cave the spawn lives in: unreachable pockets become rock
  const reachable = new Uint8Array(width * height);
  const queue: number[] = [idx(cx, cy)];
  reachable[idx(cx, cy)] = 1;
  while (queue.length > 0) {
    const at = queue.pop()!;
    const x = at % width;
    const y = (at - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = idx(nx, ny);
      if (rock[ni] || reachable[ni]) continue;
      reachable[ni] = 1;
      queue.push(ni);
    }
  }
  for (let i = 0; i < rock.length; i++) if (!rock[i] && !reachable[i]) rock[i] = 1;

  // ── dress the floor ───────────────────────────────────────────────────────────
  const glyphs: string[][] = [];
  const wallNeighbours = (x: number, y: number): number => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)] ?? 1;
    return n;
  };
  for (let y = 0; y < height; y++) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      if (rock[idx(x, y)]) {
        row.push(WALL_TILE);
        continue;
      }
      const nearRock = wallNeighbours(x, y);
      const roll = rand();
      if (nearRock >= 3 && roll < 0.3) row.push(MOSS_TILE);
      else if (nearRock >= 2 && roll < 0.36) row.push(GRAVEL_TILE);
      else if (nearRock === 0 && roll < 0.035) row.push(GLOWMOSS_TILE);
      else row.push(".");
    }
    glyphs.push(row);
  }
  // a few shallow pools, grown as short random walks over open floor
  for (let pool = 0; pool < 4; pool++) {
    let x = 1 + Math.floor(rand() * (width - 2));
    let y = 1 + Math.floor(rand() * (height - 2));
    for (let step = 0; step < 6; step++) {
      if (!rock[idx(x, y)] && Math.abs(x - cx) + Math.abs(y - cy) > SPAWN_CLEARING + 2) glyphs[y]![x] = WATER_TILE;
      x = Math.max(1, Math.min(width - 2, x + Math.floor(rand() * 3) - 1));
      y = Math.max(1, Math.min(height - 2, y + Math.floor(rand() * 3) - 1));
    }
  }

  // ── seed the dynamics: boulders, hogs, tools, giants ────────────────────────────
  const taken = new Set<string>();
  const openTile = (minSpawnDist: number, fits?: (x: number, y: number) => boolean): Coord => {
    for (let attempt = 0; attempt < 4000; attempt++) {
      const x = 1 + Math.floor(rand() * (width - 2));
      const y = 1 + Math.floor(rand() * (height - 2));
      if (rock[idx(x, y)]) continue;
      if (taken.has(`${x},${y}`)) continue;
      if (Math.abs(x - cx) + Math.abs(y - cy) < minSpawnDist) continue;
      if (fits && !fits(x, y)) continue;
      taken.add(`${x},${y}`);
      return { x, y };
    }
    // a pathological seed could exhaust attempts; land beside the spawn plaza
    return { x: cx + SPAWN_CLEARING, y: cy };
  };

  const boulders: Coord[] = [];
  for (let i = 0; i < opts.boulders; i++) boulders.push(openTile(SPAWN_CLEARING + 2));
  const hogs: Coord[] = [];
  for (let i = 0; i < opts.hogs; i++) hogs.push(openTile(SPAWN_CLEARING + 3));

  // starter tools ring the spawn plaza, like the old cave's rack by the centre
  const items: GroundItemSeed[] = (["pickaxe", "shovel", "sword", "shield"] as const).map((item, i) => {
    const tile = { x: cx - 2 + i, y: cy - 2 };
    taken.add(`${tile.x},${tile.y}`);
    return { item, ...tile };
  });

  const giantFits = (x: number, y: number): boolean => {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (rock[idx(x + dx, y + dy)] !== 0 || taken.has(`${x + dx},${y + dy}`)) return false;
      }
    }
    return true;
  };
  const bigHogs: BigHog[] = (["buff", "dino"] as const).map((style) => {
    const tile = openTile(10, giantFits);
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) taken.add(`${tile.x + dx},${tile.y + dy}`);
    return { ...tile, style };
  });

  return {
    slug: opts.slug,
    name: opts.name,
    width,
    height,
    tiles: glyphs.map((row) => row.join("")),
    boulders,
    hogs,
    items,
    bigHogs,
  };
}
