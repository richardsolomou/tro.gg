import { DEEP_WATER_TILE, FLOOR_TILE, GLOWMOSS_TILE, GRAVEL_TILE, MOSS_TILE, WALL_TILE, WATER_TILE } from "./glyphs";
import type { BirthCellSeed, Coord, DarkCreatureSeed, GroundItemSeed, Zone, ZoneExit } from "./constants";

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
 * - seeded boulders and starter tools all land on open floor.
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

  // ── seed the dynamics: boulders, tools ────────────────────────────
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

  // starter tools ring the spawn plaza, like the old cave's rack by the centre
  const items: GroundItemSeed[] = (["pickaxe", "shovel", "axe", "sword", "shield", "torch"] as const).map((item, i) => {
    const tile = { x: cx - 2 + i, y: cy - 2 };
    taken.add(`${tile.x},${tile.y}`);
    return { item, ...tile };
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
    items,
    cells: [],
    darkCreatures: [],
  };
}

/**
 * The instanced birth cave (GDD "Onboarding: the Warren"): ONE small, fully
 * enclosed template every newborn gets a private copy of — rows are scoped by a
 * per-player `birth:<identity>` zone id, the geometry is this shared, purely
 * deterministic map. A glowmoss cavern to wake in, a rubble plug to mine out
 * of a long throat, and glowmoss pools spacing the walk up to the exit
 * landing, where crossing the threshold emerges into the world. No other
 * player can ever appear or reach in.
 */
export function generateBirthCave(): Zone {
  const W = 26;
  const H = 52;
  const CAVERN_TOP = 33;
  const rand = mulberry32(0xb117);
  const idx = (x: number, y: number) => y * W + x;
  // One open glowmoss cavern under a very deep top band. The newborn wakes in
  // the cavern itself (lit, roomy — the opening frame reads at a glance); the
  // only way up is a LONG throat through the band that tapers as it climbs —
  // three wide at the cavern, then two, then one at the exit — plugged with
  // two rubble rows at its cavern end. Break the rocks where their stones
  // drop, gather them, then WALK the throat — glowmoss pools spaced along it
  // lead toward the exit without ever showing it, and the transfer threshold
  // sits at the far end, so nothing whisks you away before you've picked up
  // your haul.
  let rock = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rim = x < 2 || x >= W - 2 || y < CAVERN_TOP || y >= H - 2;
      rock[idx(x, y)] = rim || rand() < 0.3 ? 1 : 0;
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    const next = new Uint8Array(rock);
    for (let y = CAVERN_TOP; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)] ?? 1;
        next[idx(x, y)] = n >= 5 ? 1 : 0;
      }
    }
    rock = next;
  }
  const cx = Math.floor(W / 2);
  // The tapering throat: three wide leaving the cavern, two through the
  // middle, one at the top — the way out narrows as the light grows.
  const throatX = (y: number): number[] => {
    const third = (y - 4) / (CAVERN_TOP - 4);
    if (third < 1 / 3) return [cx];
    if (third < 2 / 3) return [cx, cx + 1];
    return [cx - 1, cx, cx + 1];
  };
  // The exit landing (a sealed pocket at the throat's narrowest — the roof
  // stays rock; the world transfer, not a view, is the way out), the long
  // open throat below it, and the rubble plug spanning its cavern end.
  for (let y = 1; y <= 3; y++) rock[idx(cx, y)] = 0;
  for (let y = 4; y <= CAVERN_TOP - 3; y++) for (const x of throatX(y)) rock[idx(x, y)] = 0;
  const corridor: Coord[] = [CAVERN_TOP - 2, CAVERN_TOP - 1].flatMap((y) => throatX(y).map((x) => ({ x, y })));
  for (const t of corridor) rock[idx(t.x, t.y)] = 0;
  for (const x of throatX(CAVERN_TOP - 1)) rock[idx(x, CAVERN_TOP)] = 0; // the throat always meets the cavern

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
  const centre = { x: cx, y: Math.floor((CAVERN_TOP + H - 2) / 2) };
  let spawn: Coord = { x: cx, y: CAVERN_TOP + 1 };
  let bestDist = Infinity;
  for (let y = CAVERN_TOP + 1; y < H - 2; y++) {
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

  // The throat is dressed by hand: a worn gravel path, dark between deliberate
  // glowmoss pools every few strides — clumps wandering between the walls,
  // light leading toward the exit without ever showing it — and a glowing
  // landing at the far end, so nearing the way out is unmistakable.
  for (let y = 4; y < CAVERN_TOP; y++) for (const x of throatX(y)) glyphs[y]![x] = GRAVEL_TILE;
  for (let y = 5, i = 0; y < CAVERN_TOP; y += 6, i++) {
    const cols = throatX(y);
    glyphs[y]![cols[i % cols.length]!] = GLOWMOSS_TILE;
  }
  glyphs[1]![cx] = GLOWMOSS_TILE;
  glyphs[2]![cx] = GRAVEL_TILE;
  glyphs[3]![cx] = GRAVEL_TILE;

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
    items: [],
    cells: [{ x: spawn.x, y: spawn.y, corridor, pickaxe }],
    darkCreatures: [],
  };
}
// ── the infinite world ─────────────────────────────────────────────────────────
// One seamless landmass with no edge (GDD "The fire and the dark" → Generation):
// region capitals resolve on demand from an unbounded deterministic lattice over
// the plane, and every tile's glyph is a pure function of its coordinates and
// the world seed — synthesized chunk by chunk, identically on the client and the
// module, never committed or synced. The Hearth is the one hard-coded region, at
// the origin lattice cell; everything else — biome, capital position, candidate
// name, corridors, ponds — comes out of a hash of its cell coordinates.

export const WORLD_SEED = 0x70663000;

/** The lattice pitch: every REGION_LATTICE_CELL × REGION_LATTICE_CELL cell of the
 *  plane yields exactly one region capital. (initial) */
export const REGION_LATTICE_CELL = 70;

/** How far a capital may jitter from its cell centre, as a fraction of the cell —
 *  under half a cell, so a capital can never drift into a neighbouring cell's
 *  share of the plane and `regionAt`'s 3×3 candidate search stays sufficient. (initial) */
export const REGION_JITTER_FRACTION = 0.4;

/** Chance a region rolls a small pond or stream near its capital — cosmetic
 *  variety; claiming, safety, and reachability never depend on it. (initial) */
export const REGION_WATER_CHANCE = 0.3;

/** The density ceiling: deeper regions seed more boulders/trees/dark creatures,
 *  up to this multiple of the Hearth-adjacent baseline — tougher to clear, never
 *  impossible. (initial) */
export const MAX_DEPTH_DENSITY_MULTIPLIER = 4;

/** The one hard-coded region: the origin lattice cell, the tribe's town. */
export const HEARTH_REGION_SLUG = "hearth";

/** 32-bit avalanche of a lattice/tile coordinate pair, mixed with the world seed. */
function hashCoords(x: number, y: number, salt: number): number {
  let h = (WORLD_SEED ^ salt) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function hashUnit(x: number, y: number, salt: number): number {
  return hashCoords(x, y, salt) / 4294967296;
}

/** A deterministic per-feature stream: mulberry32 seeded from cell coordinates. */
function featureRand(cellX: number, cellY: number, salt: number): () => number {
  return mulberry32(hashCoords(cellX, cellY, salt));
}

const SALT_CAPITAL_X = 0x0a11;
const SALT_CAPITAL_Y = 0x0a12;
const SALT_BIOME = 0x0b10;
const SALT_NAME = 0x0c01;
const SALT_FILL = 0x0f11;
const SALT_DECOR = 0x0dec;
const SALT_WARP_X = 0x0aa1;
const SALT_WARP_Y = 0x0aa2;
const SALT_CORRIDOR = 0x0c0d;
const SALT_POND = 0x0b0d;
const SALT_SEEDS = 0x05ee;

export interface WorldRegion {
  slug: string;
  /** The hash-derived CANDIDATE display name. Player-facing names are locked
   *  server-side in `revealed_region` the first time a region is scouted,
   *  rerolled on collision (`regionNameCandidate`) — render names from those
   *  rows, never from this field. */
  name: string;
  biome: BiomeId;
  /** The region's capital in world tiles: its cell centre plus a bounded jitter. */
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

export function regionSlug(cellX: number, cellY: number): string {
  if (cellX === 0 && cellY === 0) return HEARTH_REGION_SLUG;
  return `r${cellX}x${cellY}`;
}

/** Decode a region slug back to its lattice cell; undefined for a malformed slug. */
export function cellOfSlug(slug: string): { cellX: number; cellY: number } | undefined {
  if (slug === HEARTH_REGION_SLUG) return { cellX: 0, cellY: 0 };
  const match = /^r(-?\d+)x(-?\d+)$/.exec(slug);
  if (!match) return undefined;
  return { cellX: Number(match[1]), cellY: Number(match[2]) };
}

// ── region names: a two-part word-bank combiner tuned to the game's naming
// flavor ("Rust Gallery", "Emberrift", "Boneyard"). `sep` spells the suffix as
// its own word; otherwise the parts fuse lowercase.
const NAME_ROOTS = [
  "Rust", "Ember", "Bone", "Star", "Moss", "Frost", "Shadow", "Dust", "Glow",
  "Flood", "Ash", "Cinder", "Iron", "Salt", "Thorn", "Murk", "Gloam", "Pale",
  "Briar", "Slate", "Char", "Grim", "Sable", "Wisp", "Root", "Marrow", "Vein",
  "Drift", "Howl", "Creak", "Fell", "Lich", "Rime", "Soot", "Tallow", "Weald",
] as const;
const NAME_SUFFIXES: readonly { part: string; sep: boolean }[] = [
  { part: "gallery", sep: true },
  { part: "rift", sep: false },
  { part: "yard", sep: false },
  { part: "well", sep: false },
  { part: "glen", sep: false },
  { part: "hollow", sep: false },
  { part: "vault", sep: false },
  { part: "deep", sep: false },
  { part: "works", sep: false },
  { part: "fen", sep: false },
  { part: "mire", sep: false },
  { part: "reach", sep: true },
  { part: "fold", sep: true },
  { part: "gap", sep: true },
  { part: "warrens", sep: true },
  { part: "span", sep: true },
  { part: "run", sep: true },
  { part: "cut", sep: true },
  { part: "field", sep: true },
  { part: "shelf", sep: true },
] as const;

/**
 * The hash-derived candidate display name for a region — attempt 0 is the
 * default; the server bumps `attempt` (a deterministic secondary hash) when the
 * candidate collides with a name already locked in `revealed_region` (GDD
 * "Generation": names are the one piece of region identity that needs shared,
 * durable state, since uniqueness isn't something one region's own coordinates
 * can guarantee alone).
 */
export function regionNameCandidate(cellX: number, cellY: number, attempt = 0): string {
  if (cellX === 0 && cellY === 0) return "The Hearth";
  const h = hashCoords(cellX, cellY, SALT_NAME + attempt * 0x101);
  const root = NAME_ROOTS[h % NAME_ROOTS.length]!;
  const suffix = NAME_SUFFIXES[Math.floor(h / NAME_ROOTS.length) % NAME_SUFFIXES.length]!;
  if (suffix.sep) return `${root} ${suffix.part.charAt(0).toUpperCase()}${suffix.part.slice(1)}`;
  return `${root}${suffix.part}`;
}

const capitalCache = new Map<string, WorldRegion>();

/** The one region a lattice cell yields: capital position, biome, and candidate
 *  name, all from a hash of the cell coordinates and the world seed. */
export function capitalOf(cellX: number, cellY: number): WorldRegion {
  const key = `${cellX},${cellY}`;
  const cached = capitalCache.get(key);
  if (cached) return cached;
  let region: WorldRegion;
  const centreX = cellX * REGION_LATTICE_CELL + REGION_LATTICE_CELL / 2;
  const centreY = cellY * REGION_LATTICE_CELL + REGION_LATTICE_CELL / 2;
  if (cellX === 0 && cellY === 0) {
    // the Hearth: pinned dead-centre, always the cave biome, the fixed name
    region = { slug: HEARTH_REGION_SLUG, name: "The Hearth", biome: "cave", x: centreX, y: centreY, cellX, cellY };
  } else {
    const jitter = REGION_JITTER_FRACTION * REGION_LATTICE_CELL;
    const x = Math.round(centreX + (hashUnit(cellX, cellY, SALT_CAPITAL_X) * 2 - 1) * jitter);
    const y = Math.round(centreY + (hashUnit(cellX, cellY, SALT_CAPITAL_Y) * 2 - 1) * jitter);
    const biome = BIOMES[hashCoords(cellX, cellY, SALT_BIOME) % BIOMES.length]!;
    region = { slug: regionSlug(cellX, cellY), name: regionNameCandidate(cellX, cellY), biome, x, y, cellX, cellY };
  }
  if (capitalCache.size > 4096) capitalCache.clear();
  capitalCache.set(key, region);
  return region;
}

/** How far the warped-Voronoi domain warp can move a query point, per axis. */
const REGION_WARP_TILES = 9;

/**
 * The region owning a world tile, resolved on demand from the lattice: warp the
 * query point with deterministic value noise (organic borders instead of straight
 * Voronoi edges), then pick the nearest capital among the tile's own cell and the
 * 3×3 neighbourhood of cells around it — sufficient because REGION_JITTER_FRACTION
 * caps how far a capital can drift from its cell centre. Pure and shared: client
 * and module compute the identical region for the identical tile (invariant 7).
 */
export function regionAt(x: number, y: number): WorldRegion {
  const wx = x + (rangeNoise(x, y, 26, SALT_WARP_X) - 0.5) * 2 * REGION_WARP_TILES;
  const wy = y + (rangeNoise(x, y, 26, SALT_WARP_Y) - 0.5) * 2 * REGION_WARP_TILES;
  const cellX = Math.floor(wx / REGION_LATTICE_CELL);
  const cellY = Math.floor(wy / REGION_LATTICE_CELL);
  let best: WorldRegion | undefined;
  let bestDist = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const capital = capitalOf(cellX + dx, cellY + dy);
      const dist = Math.hypot(wx - capital.x, wy - capital.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = capital;
      }
    }
  }
  return best!;
}

/**
 * The regions lattice-adjacent to `slug` — its 8 surrounding cells, the bounded
 * search `regionAt` uses rather than a precomputed table (GDD "Generation").
 * This is the claim graph: penumbra, hop-depth, and corridor topology all read
 * it. Empty for a malformed slug.
 */
export function neighborsOf(slug: string): readonly string[] {
  const cell = cellOfSlug(slug);
  if (!cell) return [];
  const neighbors: string[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      neighbors.push(regionSlug(cell.cellX + dx, cell.cellY + dy));
    }
  }
  return neighbors;
}

/** Per-tile hash noise in [0, 1): position-keyed, never a sequential stream, so
 *  any tile's roll is computable in isolation (chunk-order independence). */
function tileHash01(x: number, y: number, salt: number): number {
  return hashUnit(x, y, salt);
}

/** Smooth low-frequency value noise: bilinear over a hashed lattice at `scale`
 *  tiles. Shared by the region warp and the rock skyline (shared/heights.ts). */
export function rangeNoise(x: number, y: number, scale: number, salt: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hashUnit(x0, y0, salt) * (1 - sx) + hashUnit(x0 + 1, y0, salt) * sx;
  const bot = hashUnit(x0, y0 + 1, salt) * (1 - sx) + hashUnit(x0 + 1, y0 + 1, salt) * sx;
  return top * (1 - sy) + bot * sy;
}

// ── the Hearth's fixed geography ────────────────────────────────────────────────
// The origin cell is a real town (GDD "Zones"): a gravel plaza ringed by stone
// huts around the First Fire, a worn path south to the coast alcove where
// newborns emerge from their birth caves, and two rivers framing the region.

const HEARTH_CAPITAL = { x: REGION_LATTICE_CELL / 2, y: REGION_LATTICE_CELL / 2 };
const TOWN_PLAZA_RADIUS = 5;
const TOWN_HUT_RING = TOWN_PLAZA_RADIUS + 5;

/** Where a fresh trogg spawns: the Hearth's capital, at the First Fire. */
export const WORLD_SPAWN: Coord = { x: HEARTH_CAPITAL.x, y: HEARTH_CAPITAL.y };

// The cave-mouth alcove south of town: a walled pocket whose deep end descends
// into your own birth cave. Carved as a fixed feature of the origin cell.
const ALCOVE = { left: 33, right: 37, top: 52, bottom: 59, mouthX: 35 };

/** Where an emerging trogg lands: inside the alcove, facing out. */
export const EMERGE_ARRIVAL: Coord = { x: ALCOVE.mouthX, y: 55 };

/** The alcove's deep end — walk into it to descend into your own cave. */
export const CAVE_DOOR: Coord = { x: ALCOVE.mouthX, y: 58 };

/** The starter tools racked beside the First Fire, on the plaza. */
export const HEARTH_STARTER_ITEMS: readonly GroundItemSeed[] = (["pickaxe", "shovel", "axe", "sword", "shield", "torch"] as const).map((item, i) => ({
  item,
  x: WORLD_SPAWN.x - 2 + i,
  y: WORLD_SPAWN.y - 2,
}));

/** The plaza carved open around every region's capital — the anchor a claim's
 *  brazier and the corridor mesh both count on being walkable. */
export const REGION_PLAZA_RADIUS = 3;

// ── on-demand tile synthesis ────────────────────────────────────────────────────
// A tile's glyph = deterministic features (town, plazas, corridors, rivers,
// ponds) layered over a cave automaton whose fill probability comes from the
// tile's region's biome averaged over its 3×3 tile neighbourhood — so borders
// blend with no seams. Chunks of GEN_CHUNK² tiles are synthesized with a halo
// wide enough that every interior tile's automaton value is exact regardless of
// which chunk asked, then cached.

const GEN_CHUNK = 32;
/** 5 smoothing passes need a 5-tile halo; +1 so decoration's wall-neighbour
 *  counts at the chunk border are exact too. */
const GEN_HALO = SMOOTH_PASSES + 1;

interface WorldFeatures {
  /** floor-class carves (plazas, corridors, the town, the alcove pocket) */
  carve: Map<string, string>;
  /** forced rock (hut walls, the alcove ring) — never over a carve */
  walls: Set<string>;
  /** water (rivers, ponds) — never over a carve or wall; a river crossing a
   *  corridor turns that tile into a wadeable ford instead */
  water: Map<string, string>;
}

function featureKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Walk a corridor between two capitals: a biased random walk seeded by the
 *  pair, clamped inside their inflated bounding box, finished with a straight
 *  L-carve so the connection is guaranteed. Returns every tile of the 2×2
 *  brush along the walk. */
function corridorTiles(a: WorldRegion, b: WorldRegion): Coord[] {
  // one walk per unordered pair: normalise so both directions carve identically
  const [from, to] = a.cellX < b.cellX || (a.cellX === b.cellX && a.cellY <= b.cellY) ? [a, b] : [b, a];
  const rand = featureRand(from.cellX * 31 + to.cellX, from.cellY * 31 + to.cellY, SALT_CORRIDOR);
  const margin = 8;
  const minX = Math.min(from.x, to.x) - margin;
  const maxX = Math.max(from.x, to.x) + margin;
  const minY = Math.min(from.y, to.y) - margin;
  const maxY = Math.max(from.y, to.y) + margin;
  const tiles: Coord[] = [];
  const stamp = (x: number, y: number) => {
    for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) tiles.push({ x: x + dx, y: y + dy });
  };
  let x = from.x;
  let y = from.y;
  const maxSteps = 3 * (Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) + 40;
  for (let step = 0; step < maxSteps && (x !== to.x || y !== to.y); step++) {
    stamp(x, y);
    const dx = to.x - x;
    const dy = to.y - y;
    // move along the axis with more ground left, mostly toward the target
    const alongX = Math.abs(dx) * (0.5 + rand()) > Math.abs(dy) * (0.5 + rand());
    if (alongX && dx !== 0) x += rand() < 0.85 ? Math.sign(dx) : -Math.sign(dx);
    else if (dy !== 0) y += rand() < 0.85 ? Math.sign(dy) : -Math.sign(dy);
    else if (dx !== 0) x += Math.sign(dx);
    x = Math.max(minX, Math.min(maxX, x));
    y = Math.max(minY, Math.min(maxY, y));
  }
  // guarantee the connection whatever the walk did: straight L to the capital
  while (x !== to.x) {
    stamp(x, y);
    x += Math.sign(to.x - x);
  }
  while (y !== to.y) {
    stamp(x, y);
    y += Math.sign(to.y - y);
  }
  stamp(to.x, to.y);
  return tiles;
}

/** A region's pond, if its REGION_WATER_CHANCE roll grants one: a short random
 *  walk of shallow water with a deep core, a little off the plaza. */
function pondTiles(region: WorldRegion): { x: number; y: number; deep: boolean }[] {
  if (region.slug === HEARTH_REGION_SLUG) return []; // the Hearth has rivers instead
  const rand = featureRand(region.cellX, region.cellY, SALT_POND);
  if (rand() >= REGION_WATER_CHANCE) return [];
  const angle = rand() * Math.PI * 2;
  const dist = REGION_PLAZA_RADIUS + 4 + rand() * 8;
  let x = Math.round(region.x + Math.cos(angle) * dist);
  let y = Math.round(region.y + Math.sin(angle) * dist);
  const tiles: { x: number; y: number; deep: boolean }[] = [];
  const steps = 6 + Math.floor(rand() * 6);
  for (let i = 0; i < steps; i++) {
    tiles.push({ x, y, deep: i < 3 });
    tiles.push({ x: x + 1, y, deep: false });
    tiles.push({ x, y: y + 1, deep: false });
    x += Math.floor(rand() * 3) - 1;
    y += Math.floor(rand() * 3) - 1;
  }
  return tiles;
}

/** The Hearth's two rivers: bounded biased walks framing the origin cell, deep
 *  water stamped 3 wide with a wadeable ford every stretch, repelled from the
 *  town. Fixed features of the world seed, like the town itself. */
function hearthRiverTiles(): { x: number; y: number; ford: boolean }[] {
  const tiles: { x: number; y: number; ford: boolean }[] = [];
  const carve = (seedSalt: number, from: Coord, to: Coord) => {
    const rand = featureRand(from.x, from.y, SALT_POND ^ seedSalt);
    let x = from.x;
    let y = from.y;
    let sinceFord = 12;
    const maxSteps = 3 * (Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) + 60;
    for (let step = 0; step < maxSteps; step++) {
      const ford = sinceFord >= 26;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) tiles.push({ x: x + dx, y: y + dy, ford });
      }
      sinceFord = ford ? 0 : sinceFord + 1;
      if (Math.abs(x - to.x) + Math.abs(y - to.y) < 3) break;
      let stepX = rand() < 0.62 ? Math.sign(to.x - x) : rand() < 0.5 ? 1 : -1;
      let stepY = rand() < 0.62 ? Math.sign(to.y - y) : rand() < 0.5 ? 1 : -1;
      if (Math.hypot(x - HEARTH_CAPITAL.x, y - HEARTH_CAPITAL.y) < TOWN_HUT_RING + 6) {
        stepX = Math.sign(x - HEARTH_CAPITAL.x) || 1;
        stepY = Math.sign(y - HEARTH_CAPITAL.y) || 1;
      }
      x += stepX;
      y += stepY;
    }
  };
  carve(0x1, { x: -28, y: 6 }, { x: 96, y: 58 });
  carve(0x2, { x: 88, y: -22 }, { x: 8, y: 94 });
  return tiles;
}

let hearthRiversCache: { x: number; y: number; ford: boolean }[] | undefined;

/**
 * Every deterministic feature overlapping the working grid `[x0, x1) × [y0, y1)`.
 * Everything here derives from capitals within a bounded cell neighbourhood, so
 * any chunk computes the identical overlay regardless of what else was ever
 * generated (invariant 7).
 */
function featuresFor(x0: number, y0: number, x1: number, y1: number): WorldFeatures {
  const carve = new Map<string, string>();
  const walls = new Set<string>();
  const water = new Map<string, string>();
  const inGrid = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const corridorKeys = new Set<string>();

  const c0x = Math.floor(x0 / REGION_LATTICE_CELL);
  const c0y = Math.floor(y0 / REGION_LATTICE_CELL);
  const c1x = Math.floor((x1 - 1) / REGION_LATTICE_CELL);
  const c1y = Math.floor((y1 - 1) / REGION_LATTICE_CELL);
  const nearHearth = c0x - 1 <= 0 && c1x + 1 >= 0 && c0y - 1 <= 0 && c1y + 1 >= 0;

  // 1. the town: plaza, the path south, and the alcove pocket
  if (nearHearth) {
    for (let dy = -TOWN_PLAZA_RADIUS; dy <= TOWN_PLAZA_RADIUS; dy++) {
      for (let dx = -TOWN_PLAZA_RADIUS; dx <= TOWN_PLAZA_RADIUS; dx++) {
        if (Math.hypot(dx, dy) > TOWN_PLAZA_RADIUS) continue;
        const x = HEARTH_CAPITAL.x + dx;
        const y = HEARTH_CAPITAL.y + dy;
        if (inGrid(x, y)) carve.set(featureKey(x, y), GRAVEL_TILE);
      }
    }
    for (let y = HEARTH_CAPITAL.y + TOWN_PLAZA_RADIUS; y < ALCOVE.top; y++) {
      if (inGrid(ALCOVE.mouthX, y)) carve.set(featureKey(ALCOVE.mouthX, y), GRAVEL_TILE);
    }
    for (let x = ALCOVE.left + 1; x < ALCOVE.right; x++) {
      for (let y = ALCOVE.top + 1; y < ALCOVE.bottom; y++) {
        if (inGrid(x, y)) carve.set(featureKey(x, y), FLOOR_TILE);
      }
    }
    if (inGrid(ALCOVE.mouthX, ALCOVE.top)) carve.set(featureKey(ALCOVE.mouthX, ALCOVE.top), GRAVEL_TILE);
  }

  // 2. every nearby region's plaza — cells within one of the grid, since a
  // capital's plaza can't reach further than its own cell plus the jitter
  for (let cy = c0y - 1; cy <= c1y + 1; cy++) {
    for (let cx = c0x - 1; cx <= c1x + 1; cx++) {
      const capital = capitalOf(cx, cy);
      for (let dy = -REGION_PLAZA_RADIUS; dy <= REGION_PLAZA_RADIUS; dy++) {
        for (let dx = -REGION_PLAZA_RADIUS; dx <= REGION_PLAZA_RADIUS; dx++) {
          if (Math.hypot(dx, dy) > REGION_PLAZA_RADIUS) continue;
          const x = capital.x + dx;
          const y = capital.y + dy;
          const key = featureKey(x, y);
          if (inGrid(x, y) && !carve.has(key)) carve.set(key, GRAVEL_TILE);
        }
      }
    }
  }

  // 3. the corridor mesh: every unordered pair of lattice-adjacent capitals
  // whose inflated bounding box could touch the grid — a full mesh, so any two
  // regions that touch on the map are always directly walkable between
  const seen = new Set<string>();
  for (let cy = c0y - 2; cy <= c1y + 2; cy++) {
    for (let cx = c0x - 2; cx <= c1x + 2; cx++) {
      const a = capitalOf(cx, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const b = capitalOf(cx + dx, cy + dy);
          const pairKey = a.slug < b.slug ? `${a.slug}|${b.slug}` : `${b.slug}|${a.slug}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          const margin = 10;
          if (Math.max(a.x, b.x) + margin < x0 || Math.min(a.x, b.x) - margin >= x1) continue;
          if (Math.max(a.y, b.y) + margin < y0 || Math.min(a.y, b.y) - margin >= y1) continue;
          for (const tile of corridorTiles(a, b)) {
            if (!inGrid(tile.x, tile.y)) continue;
            const key = featureKey(tile.x, tile.y);
            corridorKeys.add(key);
            if (!carve.has(key)) carve.set(key, FLOOR_TILE);
          }
        }
      }
    }
  }

  // 4. hut walls and the alcove ring — never over a carve, so a corridor
  // through town keeps its way open
  if (nearHearth) {
    const hutRand = featureRand(0, 0, SALT_POND ^ 0x477);
    const huts = 6;
    for (let i = 0; i < huts; i++) {
      const angle = (i / huts) * Math.PI * 2 + hutRand() * 0.5;
      const hx = Math.round(HEARTH_CAPITAL.x + Math.cos(angle) * TOWN_HUT_RING);
      const hy = Math.round(HEARTH_CAPITAL.y + Math.sin(angle) * TOWN_HUT_RING);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = hx + dx;
          const y = hy + dy;
          if (inGrid(x, y) && !carve.has(featureKey(x, y))) carve.set(featureKey(x, y), FLOOR_TILE);
        }
      }
      const doorX = Math.abs(Math.cos(angle)) >= Math.abs(Math.sin(angle)) ? -Math.sign(Math.cos(angle)) : 0;
      const doorY = doorX === 0 ? -Math.sign(Math.sin(angle)) : 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (dx === doorX && dy === doorY) continue;
          const x = hx + dx;
          const y = hy + dy;
          const key = featureKey(x, y);
          if (inGrid(x, y) && !corridorKeys.has(key)) {
            carve.delete(key);
            walls.add(key);
          }
        }
      }
    }
    // The alcove ring is unconditional — the cave door stays a dead end even
    // when a corridor's walk crosses the box — with a carved street around its
    // outside, so any corridor the ring severs reconnects along the perimeter.
    for (let x = ALCOVE.left; x <= ALCOVE.right; x++) {
      for (let y = ALCOVE.top; y <= ALCOVE.bottom; y++) {
        const rim = x === ALCOVE.left || x === ALCOVE.right || y === ALCOVE.top || y === ALCOVE.bottom;
        if (!rim) continue;
        if (x === ALCOVE.mouthX && y === ALCOVE.top) continue; // the mouth
        const key = featureKey(x, y);
        if (inGrid(x, y)) {
          carve.delete(key);
          corridorKeys.delete(key);
          walls.add(key);
        }
      }
    }
    for (let x = ALCOVE.left - 1; x <= ALCOVE.right + 1; x++) {
      for (let y = ALCOVE.top - 1; y <= ALCOVE.bottom + 1; y++) {
        const rim = x === ALCOVE.left - 1 || x === ALCOVE.right + 1 || y === ALCOVE.top - 1 || y === ALCOVE.bottom + 1;
        if (!rim) continue;
        const key = featureKey(x, y);
        if (inGrid(x, y) && !walls.has(key) && !carve.has(key)) carve.set(key, GRAVEL_TILE);
      }
    }
  }

  // 5. water: the Hearth's rivers, then each nearby region's pond roll. A river
  // crossing a corridor turns that tile into a wadeable ford; the town, the
  // alcove, and plazas stay dry.
  if (nearHearth) {
    hearthRiversCache ??= hearthRiverTiles();
    for (const tile of hearthRiversCache) {
      if (!inGrid(tile.x, tile.y)) continue;
      const key = featureKey(tile.x, tile.y);
      if (walls.has(key)) continue;
      if (carve.has(key)) {
        if (corridorKeys.has(key)) carve.set(key, WATER_TILE);
        continue;
      }
      const existing = water.get(key);
      if (tile.ford) water.set(key, WATER_TILE);
      else if (existing !== WATER_TILE) water.set(key, DEEP_WATER_TILE);
    }
  }
  for (let cy = c0y - 1; cy <= c1y + 1; cy++) {
    for (let cx = c0x - 1; cx <= c1x + 1; cx++) {
      for (const tile of pondTiles(capitalOf(cx, cy))) {
        if (!inGrid(tile.x, tile.y)) continue;
        const key = featureKey(tile.x, tile.y);
        if (walls.has(key) || carve.has(key) || water.has(key)) continue;
        water.set(key, tile.deep ? DEEP_WATER_TILE : WATER_TILE);
      }
    }
  }

  return { carve, walls, water };
}

const chunkCache = new Map<string, string[]>();
const CHUNK_CACHE_MAX = 512;

/**
 * Synthesize one GEN_CHUNK² chunk of the world. The working grid extends
 * GEN_HALO tiles past the chunk so every interior automaton value is exact —
 * two overlapping working grids compute identical values for shared tiles,
 * because every input (fill hash, features, decoration rolls) is per-tile
 * deterministic rather than a sequential stream.
 */
function buildWorldChunk(chunkX: number, chunkY: number): string[] {
  const x0 = chunkX * GEN_CHUNK - GEN_HALO;
  const y0 = chunkY * GEN_CHUNK - GEN_HALO;
  const size = GEN_CHUNK + GEN_HALO * 2;
  const idx = (x: number, y: number) => (y - y0) * size + (x - x0);

  // regions for the working grid plus one tile, for the 3×3 fill smoothing
  const fills = new Float32Array((size + 2) * (size + 2));
  for (let y = y0 - 1; y < y0 + size + 1; y++) {
    for (let x = x0 - 1; x < x0 + size + 1; x++) {
      fills[(y - (y0 - 1)) * (size + 2) + (x - (x0 - 1))] = BIOME_PARAMS[regionAt(x, y).biome].fill;
    }
  }
  const fillAt = (x: number, y: number): number => {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) sum += fills[(y + dy - (y0 - 1)) * (size + 2) + (x + dx - (x0 - 1))]!;
    }
    return sum / 9;
  };

  let rock = new Uint8Array(size * size);
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      rock[idx(x, y)] = tileHash01(x, y, SALT_FILL) < fillAt(x, y) ? 1 : 0;
    }
  }
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Uint8Array(rock);
    for (let y = y0 + 1; y < y0 + size - 1; y++) {
      for (let x = x0 + 1; x < x0 + size - 1; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += rock[idx(x + dx, y + dy)]!;
        next[idx(x, y)] = n >= 5 ? 1 : 0;
      }
    }
    rock = next;
  }

  const features = featuresFor(x0, y0, x0 + size, y0 + size);
  // resolve final solidity for the whole working grid first, so decoration's
  // wall-neighbour counts see the carved world, not the raw automaton
  const solid = new Uint8Array(size * size);
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const key = featureKey(x, y);
      if (features.walls.has(key)) solid[idx(x, y)] = 1;
      else if (features.carve.has(key)) solid[idx(x, y)] = 0;
      else if (features.water.get(key) === DEEP_WATER_TILE) solid[idx(x, y)] = 1;
      else solid[idx(x, y)] = rock[idx(x, y)]!;
    }
  }

  const rows: string[] = [];
  for (let y = chunkY * GEN_CHUNK; y < (chunkY + 1) * GEN_CHUNK; y++) {
    let row = "";
    for (let x = chunkX * GEN_CHUNK; x < (chunkX + 1) * GEN_CHUNK; x++) {
      const key = featureKey(x, y);
      if (features.walls.has(key)) {
        row += WALL_TILE;
        continue;
      }
      const carved = features.carve.get(key);
      if (carved !== undefined) {
        row += carved;
        continue;
      }
      const wet = features.water.get(key);
      if (wet !== undefined) {
        row += wet;
        continue;
      }
      if (rock[idx(x, y)]) {
        row += WALL_TILE;
        continue;
      }
      let nearRock = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nearRock += solid[idx(x + dx, y + dy)]!;
      const params = BIOME_PARAMS[regionAt(x, y).biome];
      const roll = tileHash01(x, y, SALT_DECOR);
      if (nearRock >= 3 && roll < params.moss) row += MOSS_TILE;
      else if (nearRock >= 2 && roll < params.gravel) row += GRAVEL_TILE;
      else if (nearRock === 0 && roll < params.glow) row += GLOWMOSS_TILE;
      else row += FLOOR_TILE;
    }
    rows.push(row);
  }
  return rows;
}

/** The world's tile glyph at any coordinate on the plane — synthesized on
 *  demand, chunk by chunk, and cached. Pure per invariant 7. */
export function worldGlyphAt(x: number, y: number): string {
  const chunkX = Math.floor(x / GEN_CHUNK);
  const chunkY = Math.floor(y / GEN_CHUNK);
  const key = `${chunkX},${chunkY}`;
  let chunk = chunkCache.get(key);
  if (!chunk) {
    chunk = buildWorldChunk(chunkX, chunkY);
    if (chunkCache.size >= CHUNK_CACHE_MAX) {
      // drop the oldest entries — plain FIFO is fine for a derivation cache
      let drop = chunkCache.size - CHUNK_CACHE_MAX + 1;
      for (const staleKey of chunkCache.keys()) {
        if (drop-- <= 0) break;
        chunkCache.delete(staleKey);
      }
    }
    chunkCache.set(key, chunk);
  }
  return chunk[y - chunkY * GEN_CHUNK]![x - chunkX * GEN_CHUNK]!;
}

// ── per-region seeds ────────────────────────────────────────────────────────────
// Boulders, trees, and dark creatures seed per region from an RNG stream keyed
// off that region's own capital coordinates, at a density that scales with the
// region's claim-graph hop-depth from the Hearth (GDD "Generation"). Candidate
// tiles come from a bounded flood fill out of the region's own plaza, so seeds
// always land on ground a group can actually reach — never in a sealed
// automaton pocket a claim could then never clear.

/** Baseline per-region seed counts, before depth scaling. (initial) */
export const REGION_BOULDER_COUNT = 12;
export const REGION_TREE_COUNT = 20;
export const REGION_DARK_CREATURE_COUNT = 5;

/** No dark creature seeds within this range of the First Fire, so a newborn's
 *  first steps into the world are never spawn-camped. (initial) */
const HEARTH_CREATURE_CLEARANCE = 18;

/** How a region's seed density scales with its claim-graph hop-depth from the
 *  Hearth: the Hearth-adjacent baseline at depth 1, half a baseline more per
 *  hop, capped at MAX_DEPTH_DENSITY_MULTIPLIER. */
export function densityMultiplierFor(hopDepth: number): number {
  return Math.min(MAX_DEPTH_DENSITY_MULTIPLIER, 1 + Math.max(0, hopDepth - 1) * 0.5);
}

export interface RegionSeeds {
  boulders: Coord[];
  trees: Coord[];
  darkCreatures: DarkCreatureSeed[];
}

/**
 * The dry, plaza-reachable tiles of a region, bounded by its own cell inflated
 * by the jitter + warp reach — the flood fill can spill down corridors into a
 * neighbour's ground, so membership is re-checked per tile with `regionAt`.
 */
function regionOpenTiles(region: WorldRegion): Coord[] {
  const reachBound = REGION_LATTICE_CELL; // cell + jitter + warp, generously
  const minX = region.x - reachBound;
  const maxX = region.x + reachBound;
  const minY = region.y - reachBound;
  const maxY = region.y + reachBound;
  const open: Coord[] = [];
  const seen = new Set<string>();
  const queue: Coord[] = [{ x: region.x, y: region.y }];
  seen.add(featureKey(region.x, region.y));
  while (queue.length > 0) {
    const at = queue.pop()!;
    const glyph = worldGlyphAt(at.x, at.y);
    if (glyph === WALL_TILE || glyph === DEEP_WATER_TILE) continue;
    if (glyph !== WATER_TILE && regionAt(at.x, at.y).slug === region.slug) open.push(at);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = at.x + dx;
      const ny = at.y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const key = featureKey(nx, ny);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return open;
}

/** A region's deterministic seed layout, scaled by its depth multiplier. The
 *  Hearth's own layout never includes dark creatures — it is lit ground. */
export function regionSeeds(slug: string, multiplier = 1): RegionSeeds {
  const cell = cellOfSlug(slug);
  const empty: RegionSeeds = { boulders: [], trees: [], darkCreatures: [] };
  if (!cell) return empty;
  const region = capitalOf(cell.cellX, cell.cellY);
  const open = regionOpenTiles(region);
  if (open.length === 0) return empty;
  const rand = featureRand(cell.cellX, cell.cellY, SALT_SEEDS);
  const taken = new Set<string>();
  // the plaza (and the Hearth's whole town) stays clear of seeds
  const clearance = slug === HEARTH_REGION_SLUG ? TOWN_HUT_RING + 3 : REGION_PLAZA_RADIUS + 1;
  const draw = (fits?: (tile: Coord) => boolean): Coord | undefined => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const tile = open[Math.floor(rand() * open.length)]!;
      if (taken.has(featureKey(tile.x, tile.y))) continue;
      if (Math.hypot(tile.x - region.x, tile.y - region.y) < clearance) continue;
      if (fits && !fits(tile)) continue;
      taken.add(featureKey(tile.x, tile.y));
      return tile;
    }
    return undefined;
  };
  const seeds: RegionSeeds = { boulders: [], trees: [], darkCreatures: [] };
  for (let i = 0; i < Math.round(REGION_BOULDER_COUNT * multiplier); i++) {
    const tile = draw();
    if (tile) seeds.boulders.push(tile);
  }
  for (let i = 0; i < Math.round(REGION_TREE_COUNT * multiplier); i++) {
    const tile = draw();
    if (tile) seeds.trees.push(tile);
  }
  if (slug !== HEARTH_REGION_SLUG) {
    const outsideHearthClearance = (tile: Coord) => Math.hypot(tile.x - WORLD_SPAWN.x, tile.y - WORLD_SPAWN.y) >= HEARTH_CREATURE_CLEARANCE;
    for (let i = 0; i < Math.round(REGION_DARK_CREATURE_COUNT * multiplier); i++) {
      const tile = draw(outsideHearthClearance);
      if (tile) seeds.darkCreatures.push({ ...tile, species: "grask" });
    }
  }
  return seeds;
}

/** Drop every derived-world cache — test isolation only; nothing in the game
 *  ever needs it, since the derivation is immutable for a fixed WORLD_SEED. */
export function clearWorldGenCaches(): void {
  chunkCache.clear();
  capitalCache.clear();
  hearthRiversCache = undefined;
}
