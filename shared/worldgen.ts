import { DEEP_WATER_TILE, GLOWMOSS_TILE, GRAVEL_TILE, MOSS_TILE, WALL_TILE, WATER_TILE } from "./glyphs";
import type { BigHog, BirthCellSeed, Coord, GroundItemSeed, Zone, ZoneExit } from "./constants";

/**
 * Biomes: the same cave automaton dressed differently. A biome picks the
 * decoration mix here (shared, so seeds and glyphs stay identical on both sides)
 * and its colour palette on the client (`BIOME_3D` in src/game/palette.ts).
 */
export const BIOMES = ["cave", "mossglen", "emberrift", "frosthollow", "floodways", "glowvault", "shadowdeep", "dustworks", "boneyard", "starwell", "rustgallery"] as const;
export type BiomeId = (typeof BIOMES)[number];

interface BiomeParams {
  /** Rock density fed to the automaton — low is open flats, high is tight warrens. */
  fill: number;
  /** Decoration probabilities per open tile (moss requires nearby rock, glowmoss open air). */
  moss: number;
  gravel: number;
  glow: number;
  /** How many pool random-walks to run. */
  pools: number;
}

const BIOME_PARAMS: Record<BiomeId, BiomeParams> = {
  cave: { fill: 0.42, moss: 0.3, gravel: 0.36, glow: 0.035, pools: 4 },
  mossglen: { fill: 0.38, moss: 0.62, gravel: 0.2, glow: 0.05, pools: 5 },
  emberrift: { fill: 0.47, moss: 0.08, gravel: 0.5, glow: 0.03, pools: 0 },
  frosthollow: { fill: 0.45, moss: 0.2, gravel: 0.3, glow: 0.045, pools: 7 },
  floodways: { fill: 0.36, moss: 0.35, gravel: 0.2, glow: 0.03, pools: 16 },
  glowvault: { fill: 0.44, moss: 0.25, gravel: 0.25, glow: 0.11, pools: 3 },
  shadowdeep: { fill: 0.52, moss: 0.12, gravel: 0.3, glow: 0.012, pools: 2 },
  dustworks: { fill: 0.33, moss: 0.05, gravel: 0.62, glow: 0.02, pools: 0 },
  boneyard: { fill: 0.4, moss: 0.1, gravel: 0.45, glow: 0.025, pools: 1 },
  starwell: { fill: 0.46, moss: 0.2, gravel: 0.2, glow: 0.09, pools: 6 },
  rustgallery: { fill: 0.44, moss: 0.15, gravel: 0.48, glow: 0.03, pools: 3 },
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
  trees?: number;
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
  const trees: Coord[] = [];
  for (let i = 0; i < (opts.trees ?? 0); i++) trees.push(openTile(SPAWN_CLEARING + 2));
  const hogs: Coord[] = [];
  for (let i = 0; i < opts.hogs; i++) hogs.push(openTile(SPAWN_CLEARING + 3));

  // starter tools ring the spawn plaza, like the old cave's rack by the centre
  const items: GroundItemSeed[] = (["pickaxe", "shovel", "axe", "sword", "shield", "torch"] as const).map((item, i) => {
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
    trees,
    hogs,
    items,
    bigHogs,
    cells: [],
  };
}

/**
 * The instanced birth cave (GDD "Onboarding: the Warren"): ONE small, fully
 * enclosed template every newborn gets a private copy of — rows are scoped by a
 * per-player `birth:<identity>` zone id, the geometry is this shared, purely
 * deterministic map. A sealed cell at the bottom (rubble rows plug the corridor
 * at seeding), a glowmoss cavern to cross, and the exit light at the top where
 * `E` emerges into the world. No other player can ever appear or reach in.
 */
export function generateBirthCave(): Zone {
  const W = 26;
  const H = 26;
  const rand = mulberry32(0xb117);
  const idx = (x: number, y: number) => y * W + x;
  // One open glowmoss cavern under a solid top band. The newborn wakes in the
  // cavern itself (lit, roomy — the opening frame reads at a glance); the only
  // way up to the exit landing is a 1-wide neck through the band, plugged with
  // a couple of rubble rows at seeding. Break the rocks, reach the light.
  let rock = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rim = x < 2 || x >= W - 2 || y < 6 || y >= H - 2;
      rock[idx(x, y)] = rim || rand() < 0.3 ? 1 : 0;
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    const next = new Uint8Array(rock);
    for (let y = 6; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)] ?? 1;
        next[idx(x, y)] = n >= 5 ? 1 : 0;
      }
    }
    rock = next;
  }
  const cx = Math.floor(W / 2);
  // the exit landing above the band, and the rubble neck through it
  for (let y = 2; y <= 3; y++) for (let x = cx - 1; x <= cx + 1; x++) rock[idx(x, y)] = 0;
  const corridor: Coord[] = [
    { x: cx, y: 4 },
    { x: cx, y: 5 },
  ];
  for (const t of corridor) rock[idx(t.x, t.y)] = 0;
  rock[idx(cx, 6)] = 0; // the neck always meets the cavern

  // one cavern: everything the exit can't reach returns to rock
  const reach = new Uint8Array(W * H);
  const queue = [idx(cx, 2)];
  reach[idx(cx, 2)] = 1;
  while (queue.length > 0) {
    const at = queue.pop()!;
    const x = at % W;
    const y = (at - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = idx(nx, ny);
      if (rock[ni] || reach[ni]) continue;
      reach[ni] = 1;
      queue.push(ni);
    }
  }
  for (let i = 0; i < rock.length; i++) if (!rock[i] && !reach[i]) rock[i] = 1;

  // wake in the middle of the cavern, the pickaxe on the open floor beside you
  const centre = { x: cx, y: Math.floor((6 + H - 2) / 2) };
  let spawn: Coord = { x: cx, y: 7 };
  let bestDist = Infinity;
  for (let y = 7; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      if (rock[idx(x, y)]) continue;
      const d = Math.hypot(x - centre.x, y - centre.y);
      if (d < bestDist) {
        bestDist = d;
        spawn = { x, y };
      }
    }
  }
  let pickaxe: Coord = spawn;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1], [0, -1]] as const) {
    if (!rock[idx(spawn.x + dx, spawn.y + dy)]) {
      pickaxe = { x: spawn.x + dx, y: spawn.y + dy };
      break;
    }
  }

  // dress: gravel floor, thick glowmoss — this cave lights itself
  const glyphs: string[][] = [];
  for (let y = 0; y < H; y++) {
    const row: string[] = [];
    for (let x = 0; x < W; x++) {
      if (rock[idx(x, y)]) {
        row.push(WALL_TILE);
        continue;
      }
      const roll = rand();
      if (roll < 0.12) row.push(GLOWMOSS_TILE);
      else if (roll < 0.37) row.push(GRAVEL_TILE);
      else if (roll < 0.52) row.push(MOSS_TILE);
      else row.push(".");
    }
    glyphs.push(row);
  }

  return {
    slug: "birthcave",
    name: "The Old Dark",
    width: W,
    height: H,
    biome: "shadowdeep",
    exits: [],
    spawn,
    exit: { x: cx, y: 3 },
    tiles: glyphs.map((row) => row.join("")),
    boulders: [],
    trees: [],
    hogs: [],
    items: [],
    bigHogs: [],
    cells: [{ x: spawn.x, y: spawn.y, corridor, pickaxe }],
  };
}

// ── the continent ──────────────────────────────────────────────────────────────
// One seamless landmass, grown like terrain rather than assembled from blocks:
// an irregular continent mask, organic warped-Voronoi regions around hand-laid
// capitals, ONE global cave automaton whose density varies per region (so
// borders blend, no seams), deep-water rivers crossable at fords, and a real
// town around the spawn. `generateWorld` is deterministic; `bin/generate-world`
// commits the result (tiles + per-tile region grid) to shared/world-map.ts.

export interface WorldRegion {
  slug: string;
  name: string;
  biome: BiomeId;
  /** The region's capital: the warped-Voronoi seed point in world tiles. */
  x: number;
  y: number;
}

export const WORLD_W = 224;
export const WORLD_H = 208;

export const WORLD_REGIONS: readonly WorldRegion[] = [
  { slug: "hog-town", name: "Hog Town", biome: "cave", x: 112, y: 104 },
  { slug: "glowvault", name: "Glowvault", biome: "glowvault", x: 88, y: 62 },
  { slug: "starwell", name: "Starwell", biome: "starwell", x: 138, y: 34 },
  { slug: "mossglen", name: "Mossglen", biome: "mossglen", x: 128, y: 148 },
  { slug: "boneyard", name: "Boneyard", biome: "boneyard", x: 90, y: 178 },
  { slug: "frosthollow", name: "Frosthollow", biome: "frosthollow", x: 48, y: 66 },
  { slug: "shadowdeep", name: "Shadowdeep", biome: "shadowdeep", x: 42, y: 130 },
  { slug: "floodways", name: "Floodways", biome: "floodways", x: 160, y: 176 },
  { slug: "rustgallery", name: "Rust Gallery", biome: "rustgallery", x: 184, y: 104 },
  { slug: "emberrift", name: "Emberrift", biome: "emberrift", x: 176, y: 56 },
  { slug: "dustworks", name: "Dustworks", biome: "dustworks", x: 66, y: 174 },
];

/** Region index → the single character it packs to in the committed grid. */
const REGION_CHARS = "abcdefghijk";

let regionRows: readonly string[] | undefined;

/** Wire the committed per-tile region grid (world-map.ts) into `regionAt`. */
export function setRegionRows(rows: readonly string[]): void {
  regionRows = rows;
}

/** The region owning a world tile, from the committed grid; undefined in the void. */
export function regionAt(x: number, y: number): WorldRegion | undefined {
  const char = regionRows?.[y]?.[x];
  if (!char || char === ".") return undefined;
  return WORLD_REGIONS[REGION_CHARS.indexOf(char)];
}

// deterministic value noise: a mulberry-hashed lattice, bilinearly interpolated
function latticeNoise(seed: number): (x: number, y: number) => number {
  const cell = (cx: number, cy: number): number => {
    return mulberry32((seed ^ (cx * 0x9e3779b1) ^ (cy * 0x85ebca6b)) >>> 0)();
  };
  return (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = cell(x0, y0) * (1 - sx) + cell(x0 + 1, y0) * sx;
    const bot = cell(x0, y0 + 1) * (1 - sx) + cell(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bot * sy;
  };
}

export interface GeneratedWorld {
  tiles: string[];
  regions: string[];
  boulders: Coord[];
  trees: Coord[];
  hogs: Coord[];
  items: GroundItemSeed[];
  bigHogs: BigHog[];
  cells: BirthCellSeed[];
  /** Where an emerging newborn lands: inside the coast's cave-mouth alcove. */
  arrival: Coord;
  spawn: Coord;
}

export function generateWorld(): GeneratedWorld {
  const W = WORLD_W;
  const H = WORLD_H;
  const idx = (x: number, y: number) => y * W + x;
  const spawn = { x: WORLD_REGIONS[0]!.x, y: WORLD_REGIONS[0]!.y };

  // 1. the continent: an irregular landmass, not a rectangle
  const coast = latticeNoise(0x70663001);
  const land = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x - W / 2) / (W * 0.46);
      const ny = (y - H / 2) / (H * 0.46);
      const r = Math.hypot(nx, ny);
      const wobble = (coast(x / 34, y / 34) - 0.5) * 0.9 + (coast(x / 11 + 90, y / 11) - 0.5) * 0.25;
      if (r + wobble < 0.92) land[idx(x, y)] = 1;
    }
  }

  // 2. organic regions: warped Voronoi around the capitals
  const warpX = latticeNoise(0x70663002);
  const warpY = latticeNoise(0x70663003);
  const regionOf = new Int8Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!land[idx(x, y)]) continue;
      const wx = x + (warpX(x / 26, y / 26) - 0.5) * 34;
      const wy = y + (warpY(x / 26, y / 26) - 0.5) * 34;
      let bestRegion = 0;
      let bestDist = Infinity;
      for (let i = 0; i < WORLD_REGIONS.length; i++) {
        const region = WORLD_REGIONS[i]!;
        const dist = Math.hypot(wx - region.x, wy - region.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestRegion = i;
        }
      }
      regionOf[idx(x, y)] = bestRegion;
    }
  }
  const paramsAt = (x: number, y: number): BiomeParams => {
    const region = regionOf[idx(x, y)] ?? -1;
    return BIOME_PARAMS[WORLD_REGIONS[region === -1 ? 0 : region]!.biome];
  };

  // 3. one global automaton, density varying by region — borders blend naturally
  const fillRand = mulberry32(0x70663004);
  let rock = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!land[idx(x, y)]) {
        rock[idx(x, y)] = 1;
        continue;
      }
      rock[idx(x, y)] = fillRand() < paramsAt(x, y).fill ? 1 : 0;
    }
  }
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Uint8Array(rock);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (!land[idx(x, y)]) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)]!;
        next[idx(x, y)] = n >= 5 ? 1 : 0;
      }
    }
    rock = next;
  }

  // 4. rivers: deep water winding across the continent, crossable at fords
  const water = new Uint8Array(W * H); // 1 deep, 2 ford
  const riverRand = mulberry32(0x70663005);
  const town = WORLD_REGIONS[0]!;
  const carveRiver = (from: Coord, to: Coord) => {
    let x = from.x;
    let y = from.y;
    let sinceFord = 12;
    for (let step = 0; step < W + H; step++) {
      const ford = sinceFord >= 26;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1 || !land[idx(px, py)]) continue;
          water[idx(px, py)] = ford ? 2 : Math.max(water[idx(px, py)]!, 1);
          if (ford) rock[idx(px, py)] = 0; // a ford's approach is always open
        }
      }
      sinceFord = ford ? 0 : sinceFord + 1;
      if (Math.abs(x - to.x) + Math.abs(y - to.y) < 3) break;
      // wander toward the far bank, repelled from the town plaza
      const bias = riverRand();
      let stepX = bias < 0.62 ? Math.sign(to.x - x) : bias < 0.81 ? 1 : -1;
      let stepY = riverRand() < 0.62 ? Math.sign(to.y - y) : riverRand() < 0.5 ? 1 : -1;
      if (Math.hypot(x - town.x, y - town.y) < 18) {
        stepX = Math.sign(x - town.x) || 1;
        stepY = Math.sign(y - town.y) || 1;
      }
      x = Math.max(1, Math.min(W - 2, x + stepX));
      y = Math.max(1, Math.min(H - 2, y + stepY));
    }
  };
  carveRiver({ x: 8, y: 58 }, { x: W - 8, y: 148 });
  carveRiver({ x: 150, y: 8 }, { x: 96, y: H - 8 });

  // 5. the town: a cleared plaza ringed by stone huts
  const plaza = 5;
  for (let dy = -plaza - 7; dy <= plaza + 7; dy++) {
    for (let dx = -plaza - 7; dx <= plaza + 7; dx++) {
      const d = Math.hypot(dx, dy);
      const x = town.x + dx;
      const y = town.y + dy;
      if (d <= plaza + 7) water[idx(x, y)] = 0; // no river through town
      if (d <= plaza) rock[idx(x, y)] = 0;
    }
  }
  const hutRand = mulberry32(0x70663006);
  const huts = 6;
  for (let i = 0; i < huts; i++) {
    const angle = (i / huts) * Math.PI * 2 + hutRand() * 0.5;
    const hx = Math.round(town.x + Math.cos(angle) * (plaza + 5));
    const hy = Math.round(town.y + Math.sin(angle) * (plaza + 5));
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) rock[idx(hx + dx, hy + dy)] = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx !== 0 || dy !== 0) rock[idx(hx + dx, hy + dy)] = 1;
      }
    }
    // the doorway faces the plaza
    const doorX = Math.abs(Math.cos(angle)) >= Math.abs(Math.sin(angle)) ? -Math.sign(Math.cos(angle)) : 0;
    const doorY = doorX === 0 ? -Math.sign(Math.sin(angle)) : 0;
    rock[idx(hx + doorX, hy + doorY)] = 0;
    rock[idx(hx, hy)] = 0;
  }

  // 6. connectivity: everything a trogg can't reach from spawn returns to rock
  const walkableNow = (x: number, y: number) => !rock[idx(x, y)] && water[idx(x, y)] !== 1;
  const reachable = new Uint8Array(W * H);
  const queue = [idx(spawn.x, spawn.y)];
  rock[idx(spawn.x, spawn.y)] = 0;
  water[idx(spawn.x, spawn.y)] = 0;
  reachable[idx(spawn.x, spawn.y)] = 1;
  while (queue.length > 0) {
    const at = queue.pop()!;
    const x = at % W;
    const y = (at - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = idx(nx, ny);
      if (!walkableNow(nx, ny) || reachable[ni]) continue;
      reachable[ni] = 1;
      queue.push(ni);
    }
  }
  for (let i = 0; i < rock.length; i++) {
    if (!rock[i] && water[i] !== 1 && !reachable[i]) rock[i] = 1;
  }

  // 7. dress the floor per region
  const glyphs: string[][] = [];
  const regionGrid: string[][] = [];
  const decorRand = mulberry32(0x70663007);
  const wallNeighbours = (x: number, y: number): number => {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)] ?? 1;
    return n;
  };
  for (let y = 0; y < H; y++) {
    const row: string[] = [];
    const regionRow: string[] = [];
    for (let x = 0; x < W; x++) {
      const region = regionOf[idx(x, y)] ?? -1;
      regionRow.push(region === -1 ? "." : REGION_CHARS[region]!);
      if (water[idx(x, y)] === 1 && !rock[idx(x, y)]) {
        row.push(DEEP_WATER_TILE);
        continue;
      }
      if (rock[idx(x, y)]) {
        row.push(WALL_TILE);
        continue;
      }
      if (water[idx(x, y)] === 2) {
        row.push(WATER_TILE); // the ford: wadeable shallows
        continue;
      }
      const params = paramsAt(x, y);
      const nearRock = wallNeighbours(x, y);
      const roll = decorRand();
      if (nearRock >= 3 && roll < params.moss) row.push(MOSS_TILE);
      else if (nearRock >= 2 && roll < params.gravel) row.push(GRAVEL_TILE);
      else if (nearRock === 0 && roll < params.glow) row.push(GLOWMOSS_TILE);
      else row.push(".");
    }
    glyphs.push(row);
    regionGrid.push(regionRow);
  }
  // gravel dresses the town plaza
  for (let dy = -plaza; dy <= plaza; dy++) {
    for (let dx = -plaza; dx <= plaza; dx++) {
      if (Math.hypot(dx, dy) <= plaza && glyphs[town.y + dy]![town.x + dx] === ".") glyphs[town.y + dy]![town.x + dx] = GRAVEL_TILE;
    }
  }

  // 8. seed the dynamics per region
  const taken = new Set<string>();
  const seedRand = mulberry32(0x70663008);
  const boulders: Coord[] = [];
  const hogs: Coord[] = [];
  const openTiles: Coord[][] = WORLD_REGIONS.map(() => []);
  const DRY = new Set([".", MOSS_TILE, GRAVEL_TILE, GLOWMOSS_TILE]);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const region = regionOf[idx(x, y)] ?? -1;
      // seeds keep to dry open floor: never in rivers, fords, or pools
      if (region === -1 || !DRY.has(glyphs[y]![x]!)) continue;
      if (Math.abs(x - spawn.x) + Math.abs(y - spawn.y) < 8) continue;
      openTiles[region]!.push({ x, y });
    }
  }
  const drawFrom = (region: number, rand = seedRand): Coord | undefined => {
    const pool = openTiles[region]!;
    for (let attempt = 0; attempt < 60; attempt++) {
      const tile = pool[Math.floor(rand() * pool.length)];
      if (tile && !taken.has(`${tile.x},${tile.y}`)) {
        taken.add(`${tile.x},${tile.y}`);
        return tile;
      }
    }
    return undefined;
  };
  for (let region = 0; region < WORLD_REGIONS.length; region++) {
    for (let i = 0; i < 12; i++) {
      const tile = drawFrom(region);
      if (tile) boulders.push(tile);
    }
    for (let i = 0; i < 10; i++) {
      const tile = drawFrom(region);
      if (tile) hogs.push(tile);
    }
  }
  const items: GroundItemSeed[] = (["pickaxe", "shovel", "axe", "sword", "shield", "torch"] as const).map((item, i) => {
    const tile = { x: spawn.x - 2 + i, y: spawn.y - 2 };
    taken.add(`${tile.x},${tile.y}`);
    return { item, ...tile };
  });
  const bigHogs: BigHog[] = [];
  const giantFits = (tile: Coord): boolean => {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      if (!DRY.has(glyphs[tile.y + dy]![tile.x + dx]!) || taken.has(`${tile.x + dx},${tile.y + dy}`)) return false;
    }
    return true;
  };
  for (const style of ["buff", "dino"] as const) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const tile = openTiles[0]![Math.floor(seedRand() * openTiles[0]!.length)];
      if (tile && giantFits(tile)) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) taken.add(`${tile.x + dx},${tile.y + dy}`);
        bigHogs.push({ ...tile, style });
        break;
      }
    }
  }

  // 9. trees: choppable woods scattered per region. A separate rng stream, drawn
  // after every other stage, so adding (or re-tuning) trees leaves the committed
  // tiles and all existing seeds byte-identical.
  const treeRand = mulberry32(0x70663009);
  const trees: Coord[] = [];
  for (let region = 0; region < WORLD_REGIONS.length; region++) {
    for (let i = 0; i < 20; i++) {
      const tile = drawFrom(region, treeRand);
      if (tile) trees.push(tile);
    }
  }

  // 10. the birth-cave mouth (GDD "Onboarding: the Warren"): newborns dig out
  // of their own instanced cave and step into the world HERE — a small dead-end
  // alcove burrowed into the south-coast rock, so every trogg's first steps
  // walk out of a cave mouth. Carving only turns rock into floor.
  const MOUTH_X = 112;
  let mouthY = -1;
  for (let y = H - 2; y >= Math.floor(H * 0.6); y--) {
    if (reachable[idx(MOUTH_X, y)]) {
      mouthY = y;
      break;
    }
  }
  const ARRIVAL_DEPTH = 5;
  for (let y = mouthY + 1; y <= mouthY + ARRIVAL_DEPTH && y < H - 1; y++) {
    for (let x = MOUTH_X - 1; x <= MOUTH_X + 1; x++) {
      if (glyphs[y]![x] === WALL_TILE) glyphs[y]![x] = ".";
    }
  }
  const arrival: Coord = { x: MOUTH_X, y: Math.min(mouthY + ARRIVAL_DEPTH - 1, H - 2) };
  const cells: BirthCellSeed[] = [];

  return { tiles: glyphs.map((row) => row.join("")), regions: regionGrid.map((row) => row.join("")), boulders, trees, hogs, items, bigHogs, cells, arrival, spawn };
}
