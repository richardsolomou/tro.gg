import { GLOWMOSS_TILE, GRAVEL_TILE, MOSS_TILE, WALL_TILE, WATER_TILE } from "./glyphs";
import type { BigHog, Coord, GroundItemSeed, Zone, ZoneExit } from "./constants";

/**
 * Biomes: the same cave automaton dressed differently. A biome picks the
 * decoration mix here (shared, so seeds and glyphs stay identical on both sides)
 * and its colour palette on the client (`BIOME_3D` in src/game/palette.ts).
 */
export const BIOMES = ["cave", "mossglen", "emberrift", "frosthollow", "floodways", "glowvault", "shadowdeep", "dustworks", "boneyard", "starwell", "rustgallery"] as const;
export type BiomeId = (typeof BIOMES)[number];

interface BiomeParams {
  /** Decoration probabilities per open tile (moss requires nearby rock, glowmoss open air). */
  moss: number;
  gravel: number;
  glow: number;
  /** How many pool random-walks to run. */
  pools: number;
}

const BIOME_PARAMS: Record<BiomeId, BiomeParams> = {
  cave: { moss: 0.3, gravel: 0.36, glow: 0.035, pools: 4 },
  mossglen: { moss: 0.62, gravel: 0.2, glow: 0.05, pools: 5 },
  emberrift: { moss: 0.08, gravel: 0.5, glow: 0.03, pools: 0 },
  frosthollow: { moss: 0.2, gravel: 0.3, glow: 0.045, pools: 7 },
  floodways: { moss: 0.35, gravel: 0.2, glow: 0.03, pools: 16 },
  glowvault: { moss: 0.25, gravel: 0.25, glow: 0.11, pools: 3 },
  shadowdeep: { moss: 0.12, gravel: 0.3, glow: 0.012, pools: 2 },
  dustworks: { moss: 0.05, gravel: 0.62, glow: 0.02, pools: 0 },
  boneyard: { moss: 0.1, gravel: 0.45, glow: 0.025, pools: 1 },
  starwell: { moss: 0.2, gravel: 0.2, glow: 0.09, pools: 6 },
  rustgallery: { moss: 0.15, gravel: 0.48, glow: 0.03, pools: 3 },
};

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
  biome: BiomeId;
  /** Which edges open into which neighbour zones (gates carved mid-edge). */
  exits?: Partial<Record<"north" | "south" | "east" | "west", string>>;
}

export function generateCaveZone(opts: CaveOptions): Zone {
  const { width, height, seed } = opts;
  const biome = BIOME_PARAMS[opts.biome];
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

  // ── carve the gates ───────────────────────────────────────────────────────────
  // Each exit opens the rim mid-edge and tunnels inward until it meets the cave
  // proper (carved after the connectivity fill, so the tunnel can't be sealed).
  const exits: ZoneExit[] = [];
  const gateCorridor: string[] = [];
  const gateDefs: { dir: "north" | "south" | "east" | "west"; to: string }[] = [];
  for (const dir of ["north", "south", "east", "west"] as const) {
    const to = opts.exits?.[dir];
    if (to) gateDefs.push({ dir, to });
  }
  for (const gate of gateDefs) {
    const gx = gate.dir === "west" ? 0 : gate.dir === "east" ? width - 1 : cx;
    const gy = gate.dir === "north" ? 0 : gate.dir === "south" ? height - 1 : cy;
    const step = gate.dir === "north" ? { x: 0, y: 1 } : gate.dir === "south" ? { x: 0, y: -1 } : gate.dir === "west" ? { x: 1, y: 0 } : { x: -1, y: 0 };
    let x = gx;
    let y = gy;
    // tunnel until the tile ahead is already open cave (bounded by the zone span)
    for (let carve = 0; carve < width + height; carve++) {
      rock[idx(x, y)] = 0;
      gateCorridor.push(`${x},${y}`);
      const nx = x + step.x;
      const ny = y + step.y;
      if (!rock[idx(nx, ny)]) break;
      x = nx;
      y = ny;
    }
    exits.push({ dir: gate.dir, to: gate.to, x: gx, y: gy });
  }

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
      if (nearRock >= 3 && roll < biome.moss) row.push(MOSS_TILE);
      else if (nearRock >= 2 && roll < biome.gravel) row.push(GRAVEL_TILE);
      else if (nearRock === 0 && roll < biome.glow) row.push(GLOWMOSS_TILE);
      else row.push(".");
    }
    glyphs.push(row);
  }
  // a few shallow pools, grown as short random walks over open floor
  for (let pool = 0; pool < biome.pools; pool++) {
    let x = 1 + Math.floor(rand() * (width - 2));
    let y = 1 + Math.floor(rand() * (height - 2));
    for (let step = 0; step < 6; step++) {
      if (!rock[idx(x, y)] && Math.abs(x - cx) + Math.abs(y - cy) > SPAWN_CLEARING + 2) glyphs[y]![x] = WATER_TILE;
      x = Math.max(1, Math.min(width - 2, x + Math.floor(rand() * 3) - 1));
      y = Math.max(1, Math.min(height - 2, y + Math.floor(rand() * 3) - 1));
    }
  }

  // ── seed the dynamics: boulders, hogs, tools, giants ────────────────────────────
  // nothing seeds inside a gate tunnel — an immovable boulder there would brick it
  const taken = new Set<string>(gateCorridor);
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
    biome: opts.biome,
    exits,
    tiles: glyphs.map((row) => row.join("")),
    boulders,
    hogs,
    items,
    bigHogs,
  };
}

// ── the stitched world ─────────────────────────────────────────────────────────
// One seamless coordinate space: a plus-shaped grid of biome regions, each grown
// by the same automaton with its own seed, stitched into a single tilemap with
// natural openings carved between neighbours (no gates — you walk across).
// `generateWorld` is deterministic; `bin/generate-world` runs it once and commits
// the result (shared/world-map.ts), so the world is data that can be hand-edited.

export interface WorldRegion {
  slug: string;
  name: string;
  biome: BiomeId;
  /** Grid cell (plus-shaped layout) and derived world-tile origin. */
  gx: number;
  gy: number;
  seed: number;
}

export const REGION_W = 64;
export const REGION_H = 44;

export const WORLD_REGIONS: readonly WorldRegion[] = [
  { slug: "hog-town", name: "Hog Town", biome: "cave", gx: 1, gy: 2, seed: 0x70660001 },
  { slug: "glowvault", name: "Glowvault", biome: "glowvault", gx: 1, gy: 1, seed: 0x70668071 },
  { slug: "starwell", name: "Starwell", biome: "starwell", gx: 1, gy: 0, seed: 0x70668061 },
  { slug: "mossglen", name: "Mossglen", biome: "mossglen", gx: 1, gy: 3, seed: 0x70668091 },
  { slug: "boneyard", name: "Boneyard", biome: "boneyard", gx: 1, gy: 4, seed: 0x706680a1 },
  { slug: "frosthollow", name: "Frosthollow", biome: "frosthollow", gx: 0, gy: 2, seed: 0x70667081 },
  { slug: "shadowdeep", name: "Shadowdeep", biome: "shadowdeep", gx: 0, gy: 1, seed: 0x70667071 },
  { slug: "floodways", name: "Floodways", biome: "floodways", gx: 0, gy: 3, seed: 0x70667091 },
  { slug: "rustgallery", name: "Rust Gallery", biome: "rustgallery", gx: 2, gy: 2, seed: 0x70669081 },
  { slug: "emberrift", name: "Emberrift", biome: "emberrift", gx: 2, gy: 1, seed: 0x70669071 },
  { slug: "dustworks", name: "Dustworks", biome: "dustworks", gx: 2, gy: 3, seed: 0x70669091 },
];

export const WORLD_W = 3 * REGION_W;
export const WORLD_H = 5 * REGION_H;

/** The region covering a world tile, or undefined in the void outside the plus. */
export function regionAt(x: number, y: number): WorldRegion | undefined {
  const gx = Math.floor(x / REGION_W);
  const gy = Math.floor(y / REGION_H);
  return WORLD_REGIONS.find((r) => r.gx === gx && r.gy === gy);
}

export interface GeneratedWorld {
  tiles: string[];
  boulders: Coord[];
  hogs: Coord[];
  items: GroundItemSeed[];
  bigHogs: BigHog[];
  spawn: Coord;
}

export function generateWorld(): GeneratedWorld {
  const rock = new Uint8Array(WORLD_W * WORLD_H).fill(1);
  const idx = (x: number, y: number) => y * WORLD_W + x;
  const spawn = { x: WORLD_REGIONS[0]!.gx * REGION_W + REGION_W / 2, y: WORLD_REGIONS[0]!.gy * REGION_H + REGION_H / 2 };

  // 1. grow each region's cave with its own automaton, offset into world space
  for (const region of WORLD_REGIONS) {
    const zone = generateCaveZone({
      slug: region.slug,
      name: region.name,
      width: REGION_W,
      height: REGION_H,
      seed: region.seed,
      boulders: 0,
      hogs: 0,
      biome: region.biome,
    });
    const ox = region.gx * REGION_W;
    const oy = region.gy * REGION_H;
    for (let y = 0; y < REGION_H; y++) {
      for (let x = 0; x < REGION_W; x++) {
        rock[idx(ox + x, oy + y)] = zone.tiles[y]![x] === WALL_TILE ? 1 : 0;
      }
    }
  }

  // 2. carve natural openings between neighbouring regions: two 4-wide passages
  //    per shared edge, tunnelled inward from the border until both sides open up
  const carve = (x: number, y: number) => {
    if (x > 0 && y > 0 && x < WORLD_W - 1 && y < WORLD_H - 1) rock[idx(x, y)] = 0;
  };
  const carveOpening = (borderX: number, borderY: number, axis: "x" | "y", rand: () => number) => {
    for (const half of [-1, 1]) {
      let x = borderX;
      let y = borderY;
      for (let depth = 0; depth < REGION_H; depth++) {
        for (let w = -2; w <= 1; w++) {
          if (axis === "x") carve(x + w, y);
          else carve(x, y + w);
        }
        const ahead = axis === "x" ? { x, y: y + half } : { x: x + half, y };
        if (!rock[idx(ahead.x, ahead.y)]) break;
        if (axis === "x") y += half;
        else x += half;
        // wander a little so passages read carved, not drilled
        if (rand() < 0.3) {
          if (axis === "x") x += rand() < 0.5 ? -1 : 1;
          else y += rand() < 0.5 ? -1 : 1;
        }
      }
    }
  };
  const passRand = mulberry32(0x70660777);
  for (const region of WORLD_REGIONS) {
    for (const other of WORLD_REGIONS) {
      if (other.gx === region.gx + 1 && other.gy === region.gy) {
        const bx = other.gx * REGION_W;
        const by = region.gy * REGION_H + Math.floor(REGION_H * (0.35 + passRand() * 0.3));
        carveOpening(bx, by, "y", passRand);
      }
      if (other.gy === region.gy + 1 && other.gx === region.gx) {
        const by = other.gy * REGION_H;
        const bx = region.gx * REGION_W + Math.floor(REGION_W * (0.35 + passRand() * 0.3));
        carveOpening(bx, by, "x", passRand);
      }
    }
  }

  // 3. global connectivity: everything unreachable from spawn returns to rock
  const reachable = new Uint8Array(WORLD_W * WORLD_H);
  const queue = [idx(spawn.x, spawn.y)];
  rock[idx(spawn.x, spawn.y)] = 0;
  reachable[idx(spawn.x, spawn.y)] = 1;
  while (queue.length > 0) {
    const at = queue.pop()!;
    const x = at % WORLD_W;
    const y = (at - x) / WORLD_W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= WORLD_W || ny >= WORLD_H) continue;
      const ni = idx(nx, ny);
      if (rock[ni] || reachable[ni]) continue;
      reachable[ni] = 1;
      queue.push(ni);
    }
  }
  for (let i = 0; i < rock.length; i++) if (!rock[i] && !reachable[i]) rock[i] = 1;

  // 4. dress each region's floor with its biome mix
  const glyphs: string[][] = [];
  for (let y = 0; y < WORLD_H; y++) glyphs.push(new Array(WORLD_W).fill(WALL_TILE));
  const wallNeighbours = (x: number, y: number): number => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)] ?? 1;
    return n;
  };
  for (const region of WORLD_REGIONS) {
    const params = BIOME_PARAMS[region.biome];
    const rand = mulberry32(region.seed ^ 0x5eed);
    const ox = region.gx * REGION_W;
    const oy = region.gy * REGION_H;
    for (let y = 0; y < REGION_H; y++) {
      for (let x = 0; x < REGION_W; x++) {
        const wx = ox + x;
        const wy = oy + y;
        if (rock[idx(wx, wy)]) continue;
        const nearRock = wallNeighbours(wx, wy);
        const roll = rand();
        if (nearRock >= 3 && roll < params.moss) glyphs[wy]![wx] = MOSS_TILE;
        else if (nearRock >= 2 && roll < params.gravel) glyphs[wy]![wx] = GRAVEL_TILE;
        else if (nearRock === 0 && roll < params.glow) glyphs[wy]![wx] = GLOWMOSS_TILE;
        else glyphs[wy]![wx] = ".";
      }
    }
    for (let pool = 0; pool < params.pools; pool++) {
      let x = ox + 1 + Math.floor(rand() * (REGION_W - 2));
      let y = oy + 1 + Math.floor(rand() * (REGION_H - 2));
      for (let step = 0; step < 6; step++) {
        if (!rock[idx(x, y)] && Math.abs(x - spawn.x) + Math.abs(y - spawn.y) > 6) glyphs[y]![x] = WATER_TILE;
        x = Math.max(1, Math.min(WORLD_W - 2, x + Math.floor(rand() * 3) - 1));
        y = Math.max(1, Math.min(WORLD_H - 2, y + Math.floor(rand() * 3) - 1));
      }
    }
  }

  // 5. seed the dynamics per region; starter tools and the giants stay in Hog Town
  const taken = new Set<string>();
  const boulders: Coord[] = [];
  const hogs: Coord[] = [];
  const seedRand = mulberry32(0x70660bbb);
  const openTileIn = (region: WorldRegion, minSpawnDist: number, fits?: (x: number, y: number) => boolean): Coord | undefined => {
    const ox = region.gx * REGION_W;
    const oy = region.gy * REGION_H;
    for (let attempt = 0; attempt < 3000; attempt++) {
      const x = ox + 1 + Math.floor(seedRand() * (REGION_W - 2));
      const y = oy + 1 + Math.floor(seedRand() * (REGION_H - 2));
      if (rock[idx(x, y)] || taken.has(`${x},${y}`)) continue;
      if (Math.abs(x - spawn.x) + Math.abs(y - spawn.y) < minSpawnDist) continue;
      if (fits && !fits(x, y)) continue;
      taken.add(`${x},${y}`);
      return { x, y };
    }
    return undefined;
  };
  for (const region of WORLD_REGIONS) {
    for (let i = 0; i < 14; i++) {
      const tile = openTileIn(region, 5);
      if (tile) boulders.push(tile);
    }
    for (let i = 0; i < 12; i++) {
      const tile = openTileIn(region, 6);
      if (tile) hogs.push(tile);
    }
  }
  const items: GroundItemSeed[] = (["pickaxe", "shovel", "sword", "shield"] as const).map((item, i) => {
    const tile = { x: spawn.x - 2 + i, y: spawn.y - 2 };
    taken.add(`${tile.x},${tile.y}`);
    return { item, ...tile };
  });
  const hogTown = WORLD_REGIONS[0]!;
  const giantFits = (x: number, y: number): boolean => {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      if (rock[idx(x + dx, y + dy)] !== 0 || taken.has(`${x + dx},${y + dy}`)) return false;
    }
    return true;
  };
  const bigHogs: BigHog[] = [];
  for (const style of ["buff", "dino"] as const) {
    const tile = openTileIn(hogTown, 10, giantFits);
    if (tile) {
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) taken.add(`${tile.x + dx},${tile.y + dy}`);
      bigHogs.push({ ...tile, style });
    }
  }

  return { tiles: glyphs.map((row) => row.join("")), boulders, hogs, items, bigHogs, spawn };
}
