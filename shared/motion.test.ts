import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_SPEED_TILES_PER_SEC, RUN_SPEED_TILES_PER_SEC, type Zone } from "./constants";
import { candidateTargets, facingTile, findPath, footprintTiles, footprintWalkable, lineWalkable, parsePath, projectMotion, projectMotionState, serializePath, smoothPath, snapToTile, spawnTile, spawnTiles, walkableCardinals, zoneBounds } from "./motion";

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
  assert.deepEqual(halfway, { x: 2, y: 1, z: 0, dirX: 1, dirY: 0, arrived: false });

  const arrived = projectMotionState({ x: 1, y: 1, dirX: 1, dirY: 0, path }, 10_000, open);
  assert.deepEqual(arrived, { x: 3, y: 2, z: 0, dirX: 0, dirY: 0, arrived: true });
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
  assert.deepEqual(stalled, { x: 2, y: 1, z: 0, dirX: 0, dirY: 0, arrived: false });
});

test("path motion never rewinds onto a blocked tile it has already crossed", () => {
  // A roaming creature wanders onto (2,1) — a tile the trogg already walked over — after the route
  // was planned. The projection must keep going forward (it's past that tile), not
  // snap back to it. At ~750ms (3 tiles) it's stepping into (4,1), still ahead.
  const passedBlock = zoneBounds(openRoom, (x, y) => x === 2 && y === 1);
  const path = serializePath([
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 4, y: 1 },
    { x: 5, y: 1 },
  ]);
  const ahead = projectMotionState({ x: 1, y: 1, dirX: 1, dirY: 0, path }, 750, passedBlock);
  assert.deepEqual(ahead, { x: 4, y: 1, z: 0, dirX: 1, dirY: 0, arrived: false });
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

test("facingTile names the adjacent tile only when lined up within tolerance", () => {
  assert.deepEqual(facingTile(3, 1, 1, 0), { x: 4, y: 1 }); // aligned, facing right
  assert.deepEqual(facingTile(3, 1, 0, -1), { x: 3, y: 0 }); // aligned, facing up
  assert.deepEqual(facingTile(3, 1.2, 1, 0), { x: 4, y: 1 }); // near the lane still counts (free movement)
  assert.equal(facingTile(3.5, 1, 1, 0), null); // halfway between tiles: not flush
  assert.equal(facingTile(3, 1.5, 1, 0), null); // too far off the lane
  assert.equal(facingTile(3, 1, 0, 0), null); // idle faces nothing
  assert.equal(facingTile(3, 1, 1, 1), null); // a diagonal press faces nothing
});

// --- free movement: diagonals and the wall slide ---

test("a diagonal moves both axes at normalized speed", () => {
  const at = projectMotion({ x: 2, y: 5, dirX: 1, dirY: 1 }, 1_000, open);
  const component = MOVE_SPEED_TILES_PER_SEC * Math.SQRT1_2;
  assert.ok(Math.abs(at.x - (2 + component)) < 1e-6);
  assert.ok(Math.abs(at.y - (5 + component)) < 1e-6);
});

test("a diagonal into a wall slides along it instead of stopping dead", () => {
  const wide: Zone = { slug: "w", name: "W", width: 6, height: 4, tiles: ["######", "#....#", "#....#", "######"] };
  // Up is walled from row 1, so the up-right press pins y and slides x to the far wall.
  const slid = projectMotion({ x: 1, y: 1, dirX: 1, dirY: -1 }, 10_000, zoneBounds(wide));
  assert.equal(slid.y, 1);
  assert.equal(slid.x, 4);
  // Down-right from the same spot crosses to row 2, then slides along the bottom wall.
  const both = projectMotion({ x: 1, y: 1, dirX: 1, dirY: 1 }, 10_000, zoneBounds(wide));
  assert.equal(both.y, 2);
  assert.equal(both.x, 4);
});

test("lineWalkable sees along clear floor and is blocked by walls", () => {
  const wide: Zone = { slug: "w", name: "W", width: 8, height: 5, tiles: ["########", "#......#", "#..#...#", "#......#", "########"] };
  const bounds = zoneBounds(wide);
  assert.ok(lineWalkable(bounds, { x: 1, y: 1 }, { x: 6, y: 1 })); // straight along the top row
  assert.ok(!lineWalkable(bounds, { x: 1, y: 2 }, { x: 6, y: 2 })); // pillar at (3,2) blocks
  assert.ok(lineWalkable(bounds, { x: 1, y: 1 }, { x: 2, y: 3 })); // diagonal through open floor
});

test("smoothPath collapses an open-floor route to one straight hop, keeping corners", () => {
  const wide: Zone = { slug: "w", name: "W", width: 8, height: 5, tiles: ["########", "#......#", "#..#...#", "#......#", "########"] };
  const bounds = zoneBounds(wide);
  // Open floor: the cardinal staircase route becomes a single direct glide.
  const open = smoothPath(bounds, { x: 1, y: 1 }, findPath(bounds, { x: 1, y: 1 }, { x: 6, y: 1 }));
  assert.deepEqual(open, [{ x: 6, y: 1 }]);
  // Around the pillar: at most one bend survives, and every hop is line-walkable.
  const bent = smoothPath(bounds, { x: 1, y: 2 }, findPath(bounds, { x: 1, y: 2 }, { x: 6, y: 2 }));
  assert.ok(bent.length <= 3 && bent.at(-1)!.x === 6 && bent.at(-1)!.y === 2);
  let from = { x: 1, y: 2 };
  for (const hop of bent) {
    assert.ok(lineWalkable(bounds, from, hop), `hop to ${hop.x},${hop.y} not clear`);
    from = hop;
  }
});

test("a fractional origin glides onto a route's first waypoint", () => {
  // Mid-tile at (1.4, 1) routed through (2,1) then (3,1): the lead-in hop is the
  // straight 0.6 glide onto (2,1), then whole-tile steps as usual.
  const wide: Zone = { slug: "w", name: "W", width: 6, height: 3, tiles: ["######", "#....#", "######"] };
  const bounds = zoneBounds(wide);
  const path = "2,1;3,1";
  const mid = projectMotionState({ x: 1.4, y: 1, dirX: 1, dirY: 0, path }, (0.3 / MOVE_SPEED_TILES_PER_SEC) * 1000, bounds);
  assert.ok(Math.abs(mid.x - 1.7) < 1e-6);
  const arrived = projectMotionState({ x: 1.4, y: 1, dirX: 1, dirY: 0, path }, 10_000, bounds);
  assert.deepEqual({ x: arrived.x, y: arrived.y, arrived: arrived.arrived }, { x: 3, y: 1, arrived: true });
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

test("spawnTiles fills nearby free tiles in spawn/drop order", () => {
  assert.deepEqual(spawnTiles(openRoom, none, 3, 1, 1, 0, 5), [
    { x: 4, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 5, y: 1 },
    { x: 1, y: 1 },
  ]);
});

test("spawnTiles skips blocked tiles and returns only unique free tiles", () => {
  const blocked = (x: number, y: number) => (x === 4 && y === 1) || (x === 2 && y === 1);
  assert.deepEqual(spawnTiles(openRoom, blocked, 3, 1, 1, 0, 10), [
    { x: 3, y: 1 },
    { x: 5, y: 1 },
    { x: 1, y: 1 },
    { x: 6, y: 1 },
  ]);
});

const dirKeys = (dirs: { dirX: number; dirY: number }[]) => new Set(dirs.map((d) => `${d.dirX},${d.dirY}`));

test("a sized mover's walkable headings exclude walls and the zone edge", () => {
  // (1,1) in the corner room: floor below and to the right, walls above and left.
  assert.deepEqual(dirKeys(walkableCardinals(cornered, 1, 1)), new Set(["0,1", "1,0"]));
});

test("a sized mover's walkable headings treat an occupied tile (boulder/creature/trogg) like a wall", () => {
  // (3,1) in the 1-tile-tall corridor with the tile at (4,1) occupied: only left is open.
  assert.deepEqual(dirKeys(walkableCardinals(withBoulder, 3, 1)), new Set(["-1,0"]));
});

// --- Big (2×2) footprints: a size-2 mover clamps across its whole footprint ---

// 6×4 open floor with a solid wall down column 4.
const pillar: Zone = { slug: "pillar", name: "Pillar", width: 6, height: 4, tiles: ["....#.", "....#.", "....#.", "....#."] };
const pillared = zoneBounds(pillar);

test("a 2×2 mover stops its right edge flush against a wall, a tile sooner than a 1×1", () => {
  // From x=0 on row 1: the 2×2 (cols x..x+1) halts at x=2 so cols 2,3 sit before wall col 4.
  assert.equal(projectMotion({ x: 0, y: 1, dirX: 1, dirY: 0, size: 2 }, 10_000, pillared).x, 2);
  // A 1×1 from the same spot reaches x=3, flush against the wall itself.
  assert.equal(projectMotion({ x: 0, y: 1, dirX: 1, dirY: 0 }, 10_000, pillared).x, 3);
});

test("a 2×2 mover is clamped so its whole footprint stays inside the zone", () => {
  // Open floor: a 2×2 can't pass width-2 / height-2 (its far edge would leave the zone).
  assert.equal(projectMotion({ x: 0, y: 2, dirX: 1, dirY: 0, size: 2 }, 10_000, open).x, open.width - 2);
  assert.equal(projectMotion({ x: 5, y: 0, dirX: 0, dirY: 1, size: 2 }, 10_000, open).y, open.height - 2);
});

test("a 2×2 mover's walkable headings test the whole leading edge", () => {
  // Footprint at (2,1) covers cols 2-3; stepping right would put col 3-4 onto wall col 4.
  assert.deepEqual(dirKeys(walkableCardinals(pillared, 2, 1, 2)), new Set(["-1,0", "0,-1", "0,1"]));
});

test("footprintTiles and footprintWalkable cover the size×size block", () => {
  assert.deepEqual(footprintTiles(3, 5), [{ x: 3, y: 5 }]);
  assert.deepEqual(footprintTiles(3, 5, 2), [
    { x: 3, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 6 }, { x: 4, y: 6 },
  ]);
  assert.ok(footprintWalkable(pillared, 2, 1, 2)); // cols 2-3 clear
  assert.ok(!footprintWalkable(pillared, 3, 1, 2)); // overlaps wall col 4
  assert.ok(!footprintWalkable(pillared, 5, 1, 2)); // runs off the right edge
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
