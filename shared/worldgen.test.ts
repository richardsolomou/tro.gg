import assert from "node:assert/strict";
import { test } from "node:test";
import { assertZones, isWalkable, REGION_H, REGION_W, WALL_TILE, WORLD_REGIONS, ZONES, type Zone } from "./index";
import { generateCaveZone } from "./worldgen";

const OPTS = { slug: "t", name: "t", width: 64, height: 44, seed: 0x70660001, boulders: 14, hogs: 12, biome: "cave" as const };

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

test("giants sit on clear 2×2 footprints and every seed is on open floor", () => {
  const zone = generateCaveZone(OPTS);
  for (const seed of [...zone.boulders, ...zone.hogs, ...zone.items]) {
    assert.ok(isWalkable(zone, seed.x, seed.y), `seed at ${seed.x},${seed.y} is in rock`);
  }
  for (const giant of zone.bigHogs) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        assert.ok(isWalkable(zone, giant.x + dx, giant.y + dy), `giant footprint at ${giant.x},${giant.y} blocked`);
      }
    }
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
    const ox = region.gx * REGION_W;
    const oy = region.gy * REGION_H;
    const openInRegion = world.boulders.filter((b) => b.x >= ox && b.x < ox + REGION_W && b.y >= oy && b.y < oy + REGION_H);
    assert.ok(openInRegion.length >= 10, `${region.slug} has only ${openInRegion.length} boulders`);
  }
});
