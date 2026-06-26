import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_SPEED_TILES_PER_SEC, RUN_SPEED_TILES_PER_SEC, type Zone } from "./constants";
import { candidateTargets, facingTile, findPath, parsePath, projectMotion, projectMotionState, serializePath, snapToTile, spawnTile, walkableCardinals, zoneBounds } from "./motion";

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

test("findPath routes around walls using cardinal waypoints", () => {
  const maze: Zone = {
    slug: "maze",
    name: "Maze",
    width: 7,
    height: 5,
    tiles: ["#######", "#.....#", "#.###.#", "#.....#", "#######"],
    boulders: [],
    hogs: [],
  };
  const bounds = zoneBounds(maze);
  const path = findPath(bounds, { x: 1, y: 1 }, { x: 5, y: 3 });
  assert.equal(path.length, 6);
  assert.deepEqual(path.at(-1), { x: 5, y: 3 });

  let prev = { x: 1, y: 1 };
  for (const step of path) {
    assert.equal(Math.abs(step.x - prev.x) + Math.abs(step.y - prev.y), 1);
    assert.equal(bounds.isWalkable?.(step.x, step.y), true);
    prev = step;
  }
});

test("findPath targets a reachable neighbour when the clicked tile is blocked", () => {
  const path = findPath(withBoulder, { x: 1, y: 1 }, { x: 4, y: 1 });
  assert.deepEqual(path, [
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ]);
});

test("path motion follows serialized waypoints and idles on arrival", () => {
  const path = serializePath([
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 3, y: 2 },
  ]);
  const halfway = projectMotionState({ x: 1, y: 1, dirX: 1, dirY: 0, path }, 250, open);
  assert.deepEqual(halfway, { x: 2, y: 1, dirX: 1, dirY: 0, arrived: false });

  const arrived = projectMotionState({ x: 1, y: 1, dirX: 1, dirY: 0, path }, 10_000, open);
  assert.deepEqual(arrived, { x: 3, y: 2, dirX: 0, dirY: 0, arrived: true });
  assert.deepEqual(projectMotion({ x: 1, y: 1, dirX: 1, dirY: 0, path }, 10_000, open), { x: 3, y: 2 });
});

test("path motion stalls at the tile it's entering when that tile is blocked", () => {
  // Something landed on (3,1) ahead of the route. Reaching it (500ms ≈ 2 tiles), the
  // trogg stops on the last clear tile with no heading — `arrived` stays false, the
  // signal the client keys off to re-route rather than re-decide on arrival.
  const blocked = zoneBounds(openRoom, (x, y) => x === 3 && y === 1);
  const path = serializePath([
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 4, y: 1 },
  ]);
  const stalled = projectMotionState({ x: 1, y: 1, dirX: 1, dirY: 0, path }, 500, blocked);
  assert.deepEqual(stalled, { x: 2, y: 1, dirX: 0, dirY: 0, arrived: false });
});

test("path motion never rewinds onto a blocked tile it has already crossed", () => {
  // A Hog wanders onto (2,1) — a tile the trogg already walked over — after the route
  // was planned. The projection must keep going forward (it's past that tile), not
  // snap back to it; a held route re-derived from its origin used to teleport the
  // trogg backward here. At ~750ms (3 tiles) it's stepping into (4,1), still ahead.
  const passedBlock = zoneBounds(openRoom, (x, y) => x === 2 && y === 1);
  const path = serializePath([
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 4, y: 1 },
    { x: 5, y: 1 },
  ]);
  const ahead = projectMotionState({ x: 1, y: 1, dirX: 1, dirY: 0, path }, 750, passedBlock);
  assert.deepEqual(ahead, { x: 4, y: 1, dirX: 1, dirY: 0, arrived: false });
});

test("the same tile is walkable once nothing occupies it", () => {
  const open = zoneBounds(openRoom);
  const at = projectMotion({ x: 1, y: 1, dirX: 1, dirY: 0 }, 10_000, open);
  assert.equal(at.x, 6); // walks to the far wall at column 7
});

test("snapToTile rounds a position to the nearest whole tile (grid-lock)", () => {
  assert.deepEqual(snapToTile({ x: 6.4, y: 3 }), { x: 6, y: 3 });
  assert.deepEqual(snapToTile({ x: 6.6, y: 3 }), { x: 7, y: 3 });
  assert.deepEqual(snapToTile({ x: 5, y: 5 }), { x: 5, y: 5 });
});

test("settling a mid-step slide lands the trogg on a whole tile", () => {
  // 0.6s rightward at MOVE_SPEED_TILES_PER_SEC = 2.4 tiles travelled; the grid-locked
  // origin is the nearest tile centre, never the fractional point.
  const mid = projectMotion({ x: 2, y: 5, dirX: 1, dirY: 0 }, 600, open);
  assert.equal(mid.x, 2 + MOVE_SPEED_TILES_PER_SEC * 0.6);
  assert.deepEqual(snapToTile(mid), { x: 4, y: 5 });
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

const dirKeys = (dirs: { dirX: number; dirY: number }[]) => new Set(dirs.map((d) => `${d.dirX},${d.dirY}`));

test("a hog's walkable headings exclude walls and the zone edge", () => {
  // (1,1) in the corner room: floor below and to the right, walls above and left.
  assert.deepEqual(dirKeys(walkableCardinals(cornered, 1, 1)), new Set(["0,1", "1,0"]));
});

test("a hog's walkable headings treat an occupied tile (boulder/hog/trogg) like a wall", () => {
  // (3,1) in the 1-tile-tall corridor with the tile at (4,1) occupied: only left is open.
  assert.deepEqual(dirKeys(walkableCardinals(withBoulder, 3, 1)), new Set(["-1,0"]));
});

// --- candidateTargets: where a click-to-move route may end (drives the client's
// "as close as I can get" stop in src/movement.ts) ---

test("candidateTargets returns the clicked tile itself when it's walkable", () => {
  assert.deepEqual(candidateTargets(walled, { x: 1, y: 1 }), [{ x: 1, y: 1 }]);
});

test("candidateTargets falls back to the walkable neighbours of a blocked tile", () => {
  // The pillar at (2,1): its only walkable cardinal neighbours are (1,1) and (3,1).
  const keys = new Set(candidateTargets(walled, { x: 2, y: 1 }).map((c) => `${c.x},${c.y}`));
  assert.deepEqual(keys, new Set(["1,1", "3,1"]));
});

test("candidateTargets is empty when the clicked tile and all its neighbours are blocked", () => {
  // A corner wall (0,0): the tile and every cardinal neighbour are wall or out of bounds.
  assert.deepEqual(candidateTargets(walled, { x: 0, y: 0 }), []);
});

// --- parsePath / serializePath: the click-to-move wire format ---

test("serializePath and parsePath round-trip a route", () => {
  const path = [{ x: 1, y: 2 }, { x: 1, y: 3 }, { x: 2, y: 3 }];
  assert.deepEqual(parsePath(serializePath(path)), path);
});

test("parsePath drops malformed waypoints and keeps the valid ones", () => {
  assert.deepEqual(parsePath("1,2;nope;3,x;4,5"), [{ x: 1, y: 2 }, { x: 4, y: 5 }]);
});

test("parsePath treats empty or missing input as no path", () => {
  assert.deepEqual(parsePath(""), []);
  assert.deepEqual(parsePath(undefined), []);
});
