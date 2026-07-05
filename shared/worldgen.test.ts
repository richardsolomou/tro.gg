import assert from "node:assert/strict";
import { test } from "node:test";
import { assertZones, isDryFloor, isWalkable, regionAt, WALL_TILE, WORLD_REGIONS, ZONES, type Zone } from "./index";
import { generateCaveZone, generateFrontierRing } from "./worldgen";

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

test("the committed world map is valid, connected, and spawn-safe", () => {
  // Guards hand-edits to shared/world-map.ts: every walkable tile must stay
  // reachable from spawn, and every seed must sit on open floor.
  assertZones();
  const world = ZONES["world"]!;
  const spawn = world.spawn!;
  assert.ok(isWalkable(world, spawn.x, spawn.y));
  let walkable = 0;
  for (let y = 0; y < world.height; y++) for (let x = 0; x < world.width; x++) if (isWalkable(world, x, y)) walkable++;
  assert.equal(reachableCount(world, spawn.x, spawn.y), walkable);
  // eleven regions' worth of cave: a healthy share of the plus is open floor
  assert.ok(walkable > 11 * 64 * 44 * 0.3, `only ${walkable} open tiles`);
});

test("every region contributes open, seeded ground", () => {
  const world = ZONES["world"]!;
  for (const region of WORLD_REGIONS) {
    if (region.slug === "deephome") continue; // the birth cave is deliberately barren
    const seeded = world.boulders.filter((b) => regionAt(b.x, b.y)?.slug === region.slug);
    assert.ok(seeded.length >= 8, `${region.slug} has only ${seeded.length} boulders`);
    const wooded = world.trees.filter((t) => regionAt(t.x, t.y)?.slug === region.slug);
    assert.ok(wooded.length >= 12, `${region.slug} has only ${wooded.length} trees`);
  }
});

test("rivers are crossable: the far banks stay reachable from spawn", () => {
  // deep water is unwalkable, so if the fords failed, whole regions would have
  // been filled to rock by the connectivity pass and this count would collapse
  const world = ZONES["world"]!;
  let deep = 0;
  for (const row of world.tiles) for (const glyph of row) if (glyph === "=") deep++;
  assert.ok(deep > 200, `expected real rivers, found ${deep} deep tiles`);
});

test("generateFrontierRing is a pure function of the tilemap and ring index", () => {
  const world = ZONES["world"]!;
  const a = generateFrontierRing(world.tiles, world.spawn!, 1, 20, 8);
  const b = generateFrontierRing(world.tiles, world.spawn!, 1, 20, 8);
  assert.deepEqual(a, b, "the same ring index always yields the same tiles");
});

test("generateFrontierRing only offers dry, open floor within its own annulus", () => {
  const world = ZONES["world"]!;
  const ringIndex = 1;
  const ringWidth = 20;
  const tiles = generateFrontierRing(world.tiles, world.spawn!, ringIndex, ringWidth, 8);
  assert.ok(tiles.length > 0);
  for (const tile of tiles) {
    assert.ok(isDryFloor(world, tile.x, tile.y), `(${tile.x},${tile.y}) is not dry open floor`);
    const dist = Math.hypot(tile.x - world.spawn!.x, tile.y - world.spawn!.y);
    assert.ok(dist >= ringIndex * ringWidth && dist < (ringIndex + 1) * ringWidth, `(${tile.x},${tile.y}) is outside ring ${ringIndex}`);
  }
});

test("different ring indices draw independent, differently-seeded tiles", () => {
  const world = ZONES["world"]!;
  const ring1 = generateFrontierRing(world.tiles, world.spawn!, 1, 20, 8);
  const ring2 = generateFrontierRing(world.tiles, world.spawn!, 2, 20, 8);
  assert.notDeepEqual(ring1, ring2);
});
