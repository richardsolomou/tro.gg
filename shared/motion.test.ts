import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_SPEED_TILES_PER_SEC, RUN_SPEED_TILES_PER_SEC, type Zone } from "./constants";
import { facingTile, projectMotion, walkableCardinals, spawnTile, zoneBounds } from "./motion";

// No isWalkable → open floor, clamped only to the rectangular bounds.
const open = { width: 24, height: 16 };

test("idle motion stays at the origin regardless of elapsed time", () => {
  const at = projectMotion({ x: 5, y: 5, dirX: 0, dirY: 0 }, 10_000, open);
  assert.deepEqual(at, { x: 5, y: 5 });
});

test("moving advances the origin by speed × elapsed along the direction", () => {
  const at = projectMotion({ x: 2, y: 5, dirX: 1, dirY: 0 }, 1_000, open);
  assert.equal(at.x, 2 + MOVE_SPEED_TILES_PER_SEC);
  assert.equal(at.y, 5);
});

test("running advances at run speed, not walk speed", () => {
  const at = projectMotion({ x: 2, y: 5, dirX: 1, dirY: 0, running: true }, 1_000, open);
  assert.equal(at.x, 2 + RUN_SPEED_TILES_PER_SEC);
  assert.ok(RUN_SPEED_TILES_PER_SEC > MOVE_SPEED_TILES_PER_SEC);
});

test("position is clamped to the zone bounds", () => {
  const at = projectMotion({ x: 23, y: 5, dirX: 1, dirY: 0 }, 10_000, open);
  assert.equal(at.x, open.width - 1);
});

// A 5×3 corridor with a wall pillar at (2,1): only (1,1) and (3,1) are floor.
const room: Zone = {
  slug: "test",
  name: "Test",
  width: 5,
  height: 3,
  tiles: ["#####", "#.#.#", "#####"],
};
const walled = zoneBounds(room);

test("moving toward a wall stops flush against it, not through it", () => {
  const at = projectMotion({ x: 1, y: 1, dirX: 1, dirY: 0 }, 10_000, walled);
  assert.equal(at.x, 1); // pillar at col 2 blocks entry
  assert.equal(at.y, 1);
});

test("moving the other way stops flush against the same wall", () => {
  const at = projectMotion({ x: 3, y: 1, dirX: -1, dirY: 0 }, 10_000, walled);
  assert.equal(at.x, 3);
});

test("the zone border blocks vertical movement off the floor", () => {
  const at = projectMotion({ x: 1, y: 1, dirX: 0, dirY: -1 }, 10_000, walled);
  assert.equal(at.y, 1); // row 0 is all wall
});

// A 5×4 room with a pillar at (2,2) but open at (2,1) — tests the 1×1 footprint
// spanning two tile rows when the trogg is mid-tile vertically.
const corner: Zone = {
  slug: "corner",
  name: "Corner",
  width: 5,
  height: 4,
  tiles: ["#####", "#...#", "#.#.#", "#####"],
};
const cornered = zoneBounds(corner);

test("a tile-aligned trogg slides past a pillar one row below it", () => {
  const at = projectMotion({ x: 1, y: 1, dirX: 1, dirY: 0 }, 10_000, cornered);
  assert.equal(at.x, 3); // only row 1 matters; flush against the right wall
});

test("a mid-tile trogg is blocked by a pillar its footprint overlaps", () => {
  const at = projectMotion({ x: 1, y: 1.5, dirX: 1, dirY: 0 }, 10_000, cornered);
  assert.equal(at.x, 1); // footprint spans rows 1–2; the pillar at (2,2) blocks it
});

// An open 8×3 corridor with a dynamic obstacle (boulder) at (4,1).
const openRoom: Zone = {
  slug: "open",
  name: "Open",
  width: 8,
  height: 3,
  tiles: ["########", "#......#", "########"],
};
const withBoulder = zoneBounds(openRoom, (x, y) => x === 4 && y === 1);

test("a boulder occupies its tile and stops a trogg flush like a wall", () => {
  const at = projectMotion({ x: 1, y: 1, dirX: 1, dirY: 0 }, 10_000, withBoulder);
  assert.equal(at.x, 3); // flush against the boulder at column 4
});

test("the same tile is walkable once nothing occupies it", () => {
  const open = zoneBounds(openRoom);
  const at = projectMotion({ x: 1, y: 1, dirX: 1, dirY: 0 }, 10_000, open);
  assert.equal(at.x, 6); // walks to the far wall at column 7
});

const dirKeys = (dirs: { dirX: number; dirY: number }[]) => new Set(dirs.map((d) => `${d.dirX},${d.dirY}`));

test("a hog's walkable headings exclude walls and the zone edge", () => {
  // (1,1) in the corner room: floor below and to the right, walls above and left.
  assert.deepEqual(dirKeys(walkableCardinals(cornered, 1, 1)), new Set(["0,1", "1,0"]));
});

test("a hog's walkable headings treat a boulder like a wall", () => {
  // (3,1) in the 1-tile-tall corridor with a boulder at (4,1): only left is open.
  assert.deepEqual(dirKeys(walkableCardinals(withBoulder, 3, 1)), new Set(["-1,0"]));
});

test("facingTile names the adjacent tile only when squarely aligned", () => {
  assert.deepEqual(facingTile(3, 1, 1, 0), { x: 4, y: 1 }); // aligned, facing right
  assert.deepEqual(facingTile(3, 1, 0, -1), { x: 3, y: 0 }); // aligned, facing up
  assert.equal(facingTile(3.5, 1, 1, 0), null); // mid-tile on the moving axis
  assert.equal(facingTile(3, 1.5, 1, 0), null); // off-axis: not lined up
  assert.equal(facingTile(3, 1, 0, 0), null); // idle faces nothing
});

const none = () => false;

test("spawnTile drops the entity on the tile the player faces when it's free", () => {
  assert.deepEqual(spawnTile(openRoom, none, 3, 1, 1, 0), { x: 4, y: 1 }); // facing right
  assert.deepEqual(spawnTile(openRoom, none, 3, 1, -1, 0), { x: 2, y: 1 }); // facing left
});

test("spawnTile falls back to a free neighbour when the player is idle", () => {
  // Idle at (3,1) in a 1-tall corridor: the facing tile is skipped; the first
  // free orthogonal neighbour (right) is taken, never the player's own tile.
  assert.deepEqual(spawnTile(openRoom, none, 3, 1, 0, 0), { x: 4, y: 1 });
});

test("spawnTile skips the faced tile when a wall or another entity blocks it", () => {
  // Facing right into the far wall at column 7 from (6,1): wall is skipped, the
  // free left neighbour is used instead.
  assert.deepEqual(spawnTile(openRoom, none, 6, 1, 1, 0), { x: 5, y: 1 });
  // Faced tile occupied by a boulder → skip to a free neighbour.
  const boulderAt4 = (x: number, y: number) => x === 4 && y === 1;
  assert.deepEqual(spawnTile(openRoom, boulderAt4, 3, 1, 1, 0), { x: 2, y: 1 });
});

test("spawnTile returns null when the player is boxed in", () => {
  // A single free tile (1,1) ringed by walls: every neighbour is a wall, and the
  // player's own tile is the only floor — so it's used as the last resort.
  const cell: Zone = { slug: "cell", name: "Cell", width: 3, height: 3, tiles: ["###", "#.#", "###"], boulders: [] };
  assert.deepEqual(spawnTile(cell, none, 1, 1, 0, 0), { x: 1, y: 1 });
  // Now mark even that tile occupied: nothing free anywhere → null.
  assert.equal(spawnTile(cell, () => true, 1, 1, 0, 0), null);
});
