import assert from "node:assert/strict";
import { test } from "node:test";
import { assertZones, isDryFloor, isWalkable, regionAt, WALL_TILE, ZONES, type Zone } from "./index";
import {
  capitalOf,
  CAVE_DOOR,
  cellOfSlug,
  clearWorldGenCaches,
  densityMultiplierFor,
  EMERGE_ARRIVAL,
  generateCaveZone,
  MAX_DEPTH_DENSITY_MULTIPLIER,
  neighborsOf,
  REGION_JITTER_FRACTION,
  REGION_LATTICE_CELL,
  regionNameCandidate,
  regionSeeds,
  regionSlug,
  worldGlyphAt,
  WORLD_SPAWN,
} from "./worldgen";

const OPTS = { slug: "t", name: "t", width: 64, height: 44, seed: 0x70660001, boulders: 14, biome: "cave" as const };

function reachableCount(zone: Zone, fromX: number, fromY: number): number {
  const seen = new Set<string>([`${fromX},${fromY}`]);
  const queue = [{ x: fromX, y: fromY }];
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = at.x + dx;
      const ny = at.y + dy;
      if (!isWalkable(zone, nx, ny) || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen.size;
}

test("the same seed generates the identical zone", () => {
  const a = generateCaveZone(OPTS);
  const b = generateCaveZone(OPTS);
  assert.deepEqual(a, b);
});

test("a different seed generates a different cave", () => {
  const a = generateCaveZone(OPTS);
  const b = generateCaveZone({ ...OPTS, seed: OPTS.seed + 1 });
  assert.notDeepEqual(a.tiles, b.tiles);
});

test("the generated zone passes registry validation", () => {
  assertZones({ t: generateCaveZone(OPTS) });
});

test("the rim is solid rock", () => {
  const zone = generateCaveZone(OPTS);
  for (let x = 0; x < zone.width; x++) {
    assert.equal(zone.tiles[0]![x], WALL_TILE);
    assert.equal(zone.tiles[zone.height - 1]![x], WALL_TILE);
  }
  for (let y = 0; y < zone.height; y++) {
    assert.equal(zone.tiles[y]![0], WALL_TILE);
    assert.equal(zone.tiles[y]![zone.width - 1], WALL_TILE);
  }
});

test("the spawn plaza is open and every walkable tile is reachable from it", () => {
  const zone = generateCaveZone(OPTS);
  const cx = Math.floor(zone.width / 2);
  const cy = Math.floor(zone.height / 2);
  assert.ok(isWalkable(zone, cx, cy));
  let walkable = 0;
  for (let y = 0; y < zone.height; y++) for (let x = 0; x < zone.width; x++) if (isWalkable(zone, x, y)) walkable++;
  assert.equal(reachableCount(zone, cx, cy), walkable);
  // the cave is a world, not a corridor: at least a third of the interior is open
  assert.ok(walkable > zone.width * zone.height * 0.33, `only ${walkable} open tiles`);
});

test("every seed is on open floor", () => {
  const zone = generateCaveZone(OPTS);
  for (const seed of [...zone.boulders, ...zone.trees, ...zone.items]) {
    assert.ok(isWalkable(zone, seed.x, seed.y), `seed at ${seed.x},${seed.y} is in rock`);
  }
  const world = ZONES["world"]!;
  for (const seed of [...world.boulders, ...world.trees, ...world.items]) {
    assert.ok(isDryFloor(world, seed.x, seed.y), `world seed at ${seed.x},${seed.y} is wet or in rock`);
  }
});

// ── the infinite lattice (GDD "Generation") ────────────────────────────────────
// There is no whole map to pass over, so the generator's local invariants are
// validated property-style at arbitrary, far-flung lattice coordinates.

const FAR_CELLS: readonly [number, number][] = [
  [3, -2],
  [-40, 17],
  [250, 250],
  [-1000, 4],
  [77, -813],
];

/** BFS over walkable world tiles from `from`, bounded to a box around it. */
function worldReaches(from: { x: number; y: number }, to: { x: number; y: number }, boxRadius = 200): boolean {
  const world = ZONES["world"]!;
  const seen = new Set([`${from.x},${from.y}`]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at.x === to.x && at.y === to.y) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = at.x + dx;
      const ny = at.y + dy;
      if (Math.abs(nx - from.x) > boxRadius || Math.abs(ny - from.y) > boxRadius) continue;
      const key = `${nx},${ny}`;
      if (seen.has(key) || !isWalkable(world, nx, ny)) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return false;
}

test("the world zone passes registry validation", () => {
  assertZones();
});

test("tile synthesis is deterministic and chunk-order independent", () => {
  const probes: [number, number][] = [
    [12345, -6789],
    [-31, 7],
    [70000, 70001],
  ];
  const first = probes.map(([x, y]) => worldGlyphAt(x, y));
  clearWorldGenCaches();
  // touch surrounding chunks first, in a different order, then re-ask
  for (const [x, y] of probes) for (const d of [64, -64, 32]) worldGlyphAt(x + d, y - d);
  const second = probes.map(([x, y]) => worldGlyphAt(x, y));
  assert.deepEqual(second, first);
});

test("capitals stay within their own cell's share of the plane", () => {
  for (const [cx, cy] of FAR_CELLS) {
    const capital = capitalOf(cx, cy);
    const centreX = cx * REGION_LATTICE_CELL + REGION_LATTICE_CELL / 2;
    const centreY = cy * REGION_LATTICE_CELL + REGION_LATTICE_CELL / 2;
    const jitter = REGION_JITTER_FRACTION * REGION_LATTICE_CELL;
    assert.ok(Math.abs(capital.x - centreX) <= jitter, `${capital.slug} drifted ${capital.x - centreX} on x`);
    assert.ok(Math.abs(capital.y - centreY) <= jitter, `${capital.slug} drifted ${capital.y - centreY} on y`);
  }
});

test("region slugs round-trip through cellOfSlug", () => {
  assert.deepEqual(cellOfSlug(regionSlug(0, 0)), { cellX: 0, cellY: 0 });
  assert.deepEqual(cellOfSlug(regionSlug(-12, 900)), { cellX: -12, cellY: 900 });
  assert.equal(cellOfSlug("not-a-region"), undefined);
});

test("every far-flung capital's plaza is open floor", () => {
  const world = ZONES["world"]!;
  for (const [cx, cy] of FAR_CELLS) {
    const capital = capitalOf(cx, cy);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        assert.ok(isWalkable(world, capital.x + dx, capital.y + dy), `${capital.slug} plaza blocked at ${dx},${dy}`);
      }
    }
  }
});

test("a region's plaza is corridor-connected to every lattice neighbour's plaza", () => {
  for (const [cx, cy] of [[0, 0], [250, 250]] as const) {
    const capital = capitalOf(cx, cy);
    for (const neighborSlug of neighborsOf(capital.slug)) {
      const cell = cellOfSlug(neighborSlug)!;
      const neighbor = capitalOf(cell.cellX, cell.cellY);
      assert.ok(worldReaches({ x: capital.x, y: capital.y }, { x: neighbor.x, y: neighbor.y }), `${capital.slug} cannot walk to ${neighborSlug}`);
    }
  }
});

test("region seeds land on dry open floor inside their own region", () => {
  const world = ZONES["world"]!;
  for (const [cx, cy] of FAR_CELLS.slice(0, 3)) {
    const slug = regionSlug(cx, cy);
    const seeds = regionSeeds(slug);
    assert.ok(seeds.boulders.length > 0, `${slug} seeded no boulders`);
    assert.ok(seeds.trees.length > 0, `${slug} seeded no trees`);
    assert.ok(seeds.darkCreatures.length > 0, `${slug} seeded no dark creatures`);
    for (const seed of [...seeds.boulders, ...seeds.trees, ...seeds.darkCreatures]) {
      assert.ok(isDryFloor(world, seed.x, seed.y), `${slug} seed at ${seed.x},${seed.y} is wet or in rock`);
      assert.equal(regionAt(seed.x, seed.y).slug, slug, `${slug} seed at ${seed.x},${seed.y} is in another region`);
    }
  }
});

test("seed density scales with hop-depth up to the ceiling", () => {
  assert.equal(densityMultiplierFor(1), 1);
  assert.ok(densityMultiplierFor(3) > densityMultiplierFor(1));
  assert.equal(densityMultiplierFor(99), MAX_DEPTH_DENSITY_MULTIPLIER);
  const slug = regionSlug(3, -2);
  const base = regionSeeds(slug, 1);
  const dense = regionSeeds(slug, MAX_DEPTH_DENSITY_MULTIPLIER);
  assert.ok(dense.darkCreatures.length > base.darkCreatures.length, "deeper regions must seed more creatures");
});

test("the hearth never seeds dark creatures — it is lit ground", () => {
  assert.equal(regionSeeds("hearth").darkCreatures.length, 0);
});

test("candidate names are deterministic and reroll on a bumped attempt", () => {
  assert.equal(regionNameCandidate(3, -7), regionNameCandidate(3, -7));
  assert.notEqual(regionNameCandidate(3, -7), regionNameCandidate(3, -7, 1));
  assert.equal(regionNameCandidate(0, 0), "The Hearth");
});

test("the hearth's fixed anchors are walkable and the alcove is sealed but for its mouth", () => {
  const world = ZONES["world"]!;
  assert.ok(isWalkable(world, WORLD_SPAWN.x, WORLD_SPAWN.y));
  assert.ok(isWalkable(world, EMERGE_ARRIVAL.x, EMERGE_ARRIVAL.y));
  assert.ok(isWalkable(world, CAVE_DOOR.x, CAVE_DOOR.y));
  // the pocket's deep end is a dead end: rock left, right, and below the door
  assert.ok(!isWalkable(world, CAVE_DOOR.x - 2, CAVE_DOOR.y));
  assert.ok(!isWalkable(world, CAVE_DOOR.x + 2, CAVE_DOOR.y));
  assert.ok(!isWalkable(world, CAVE_DOOR.x, CAVE_DOOR.y + 1));
  // and the arrival can still walk out to the spawn
  assert.ok(worldReaches(EMERGE_ARRIVAL, WORLD_SPAWN));
});
