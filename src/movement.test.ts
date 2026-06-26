import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coord, Facing, ProjectedMotion, ZoneBounds } from "@trogg/shared";
import type { Player } from "./module_bindings/types";
import type { Tracked } from "./entities.js";
import type { MoveIntent } from "./input.js";
import { createSelfController, type SelfControllerDeps } from "./movement.js";

// A pure stand-in for the avatar layer's facingFromDir (cardinal → label; idle holds last).
const facingFromDir = (dirX: number, dirY: number, last: Facing): Facing =>
  dirY < 0 ? "up" : dirY > 0 ? "down" : dirX < 0 ? "left" : dirX > 0 ? "right" : last;

interface MoveCall {
  dirX: number;
  dirY: number;
  running: boolean;
}

function harness(over: Partial<SelfControllerDeps> = {}) {
  const moves: MoveCall[] = [];
  const moveTos: Coord[] = [];
  let pushes = 0;
  const hogTiles = new Set<string>();
  const boulderTiles = new Set<string>();
  const destinations: (Coord | undefined)[] = [];

  const player = {
    x: 0,
    y: 0,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    movedAt: { microsSinceUnixEpoch: 0n },
  } as unknown as Player;
  const entry = { player, baseMs: 0, facing: "down" as Facing, frameKey: "", carriedKind: "" } as unknown as Tracked;

  const conn = {
    reducers: {
      move: (i: MoveCall) => moves.push(i),
      moveTo: (t: Coord & { running: boolean }) => moveTos.push({ x: t.x, y: t.y }),
      push: () => pushes++,
    },
  } as unknown as SelfControllerDeps["conn"];

  const self = createSelfController({
    conn,
    bounds: { width: 20, height: 20 } as ZoneBounds,
    hogTiles,
    boulderTiles,
    pushEnabled: true,
    getSelf: () => entry,
    showDestination: (tile) => destinations.push(tile),
    toBaseMs: () => 1000,
    facingFromDir,
    audio: { playFootstep: () => {}, playBoulderPush: () => {} },
    ...over,
  });

  const motion = (x: number, y: number, dirX: number, dirY: number, arrived = false): ProjectedMotion => ({ x, y, dirX, dirY, arrived });
  return { self, entry, player, moves, moveTos, pushes: () => pushes, hogTiles, boulderTiles, destinations, motion };
}

const idle: MoveIntent = { dirX: 0, dirY: 0, running: false };
const right: MoveIntent = { dirX: 1, dirY: 0, running: false };
const down: MoveIntent = { dirX: 0, dirY: 1, running: false };

test("pressing the faced direction walks immediately", () => {
  const h = harness();
  h.self.onIntent(down); // already facing down
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0);
  assert.deepEqual(h.moves.at(-1), down);
});

test("pressing an unfaced direction turns in place without moving", () => {
  const h = harness();
  h.self.onIntent(right); // facing is down, so this should turn, not walk
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0);
  assert.equal(h.moves.length, 0);
  assert.deepEqual({ dirX: h.self.facing.dirX, dirY: h.self.facing.dirY }, { dirX: 1, dirY: 0 });
});

test("holding the faced direction past the turn beat starts walking", () => {
  const h = harness();
  h.self.onIntent(right);
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // turns in place, arms walkAfter
  assert.equal(h.moves.length, 0);
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 1000); // well past TURN_TAP_MS
  assert.deepEqual(h.moves.at(-1), right);
});

test("a held run re-bases the origin once per tile centre crossed", () => {
  const h = harness();
  h.self.onIntent(right, true); // sends the initial move(right), origin tile (0,0)
  h.moves.length = 0;
  h.self.update(h.entry, h.motion(0.05, 0, 1, 0), 0); // same tile, no re-base
  h.self.update(h.entry, h.motion(0.5, 0, 1, 0), 1); // mid-tile, not a centre
  assert.equal(h.moves.length, 0);
  h.self.update(h.entry, h.motion(1, 0, 1, 0), 2); // crossed into tile 1 → re-base
  assert.deepEqual(h.moves.at(-1), right);
});

test("walking flush into a Hog stops the trogg, keeping it idle (no stale intent)", () => {
  const h = harness();
  h.self.onIntent(right, true);
  h.moves.length = 0;
  h.hogTiles.add("1,0"); // Hog on the tile directly ahead
  h.self.update(h.entry, h.motion(0, 0, 1, 0), 0); // flush on centre against the Hog
  assert.deepEqual(h.moves.at(-1), { dirX: 0, dirY: 0, running: false });
});

test("a server row that matches a pending move is an ack, not a snap", () => {
  const h = harness();
  h.self.onIntent(right, true); // optimistic move(right) from (0,0)
  const server = { x: 0, y: 0, dirX: 1, dirY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 5n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  // Predicted motion is kept (intent stays right); baseMs is NOT reset to the server stamp.
  assert.equal(h.entry.player.dirX, 1);
  assert.notEqual(h.entry.baseMs, 1000);
});

test("a server row that matches nothing snaps to authority", () => {
  const h = harness();
  const server = { x: 7, y: 3, dirX: 0, dirY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 9n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  assert.equal(h.entry.player.x, 7);
  assert.equal(h.entry.player.y, 3);
  assert.equal(h.entry.baseMs, 1000); // re-based to the server stamp via toBaseMs
});

test("a push blocked by a Hog beyond the boulder retries until it clears", () => {
  const h = harness();
  h.boulderTiles.add("1,0"); // boulder directly ahead
  h.self.onIntent(right, true); // commit to walking right, flush against the boulder
  h.self.update(h.entry, h.motion(0, 0, 1, 0), 0); // rising edge: one shove
  assert.equal(h.pushes(), 1);
  h.self.update(h.entry, h.motion(0, 0, 1, 0), 100); // still flush, within the retry throttle
  assert.equal(h.pushes(), 1);
  h.self.update(h.entry, h.motion(0, 0, 1, 0), 300); // throttle elapsed → retry (so it resumes once the Hog leaves)
  assert.equal(h.pushes(), 2);
});

test("a click queues a destination and routes from a tile centre", () => {
  const h = harness();
  h.self.onClick({ x: 4, y: 2 });
  assert.deepEqual(h.destinations.at(-1), { x: 4, y: 2 });
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // idle, already centred → routes now
  assert.deepEqual(h.moveTos.at(-1), { x: 4, y: 2 });
});

test("clicking a tile we're already on clears the marker instead of retrying forever", () => {
  const h = harness();
  h.self.onClick({ x: 0, y: 0 }); // our own tile
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // flushes the (no-op) moveTo
  // Server answers with an empty path (findPath returns [] for the current tile).
  const server = { x: 0, y: 0, dirX: 0, dirY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 1n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  const before = h.moveTos.length;
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 1000); // well past the retry throttle
  assert.equal(h.destinations.at(-1), undefined); // marker cleared
  assert.equal(h.moveTos.length, before); // no further moveTo spam
});
