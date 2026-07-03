import assert from "node:assert/strict";
import { test } from "node:test";
import type { Coord, Facing, ProjectedMotion, ZoneBounds } from "@trogg/shared";
import type { Player } from "./net/module_bindings/types";
import type { MotionEntry } from "./movement.js";
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

interface FaceCall {
  dirX: number;
  dirY: number;
}

function harness(over: Partial<SelfControllerDeps> = {}) {
  const moves: MoveCall[] = [];
  const faces: FaceCall[] = [];
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
    faceX: 0,
    faceY: 1,
    running: false,
    path: "",
    movedAt: { microsSinceUnixEpoch: 0n },
  } as unknown as Player;
  const entry = { player, baseMs: 0, facing: "down" as Facing } satisfies MotionEntry;

  const conn = {
    reducers: {
      move: (i: MoveCall) => moves.push(i),
      face: (i: FaceCall) => faces.push(i),
      moveTo: (t: Coord & { running: boolean }) => moveTos.push({ x: t.x, y: t.y }),
      push: () => pushes++,
    },
  } as unknown as SelfControllerDeps["conn"];

  const self = createSelfController({
    conn,
    // Like production, the bounds treat hog and boulder tiles as unwalkable, so the
    // controller's can-I-progress probe collides with them (world3d's zoneBounds wiring).
    bounds: { width: 20, height: 20, isWalkable: (x, y) => !hogTiles.has(`${x},${y}`) && !boulderTiles.has(`${x},${y}`) } as ZoneBounds,
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
  return { self, entry, player, moves, faces, moveTos, pushes: () => pushes, hogTiles, boulderTiles, destinations, motion };
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

test("the first keypress honours the synced self row facing", () => {
  const h = harness();
  h.entry.player.faceX = 1;
  h.entry.player.faceY = 0;
  h.self.onIntent(right);
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0);
  assert.deepEqual(h.moves.at(-1), right);
  assert.equal(h.faces.length, 0);
});

test("pressing a new direction walks immediately and faces it (free movement)", () => {
  const h = harness();
  h.self.onIntent(right); // facing is down — no turn-in-place beat, just go
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0);
  assert.deepEqual(h.moves.at(-1), right);
  assert.deepEqual({ dirX: h.self.facing.dirX, dirY: h.self.facing.dirY }, { dirX: 1, dirY: 0 });
});

test("changing direction mid-walk re-bases from the fractional spot, no snap", () => {
  const h = harness();
  h.self.onIntent(right, true);
  h.self.onIntent(down);
  h.self.update(h.entry, h.motion(0.4, 0, 1, 0), 16); // mid-tile when the new key lands
  assert.deepEqual(h.moves.at(-1), down);
  assert.equal(h.entry.player.x, 0.4); // origin stays fractional — nothing banks or snaps
});

test("a diagonal intent is sent as-is and faces its dominant axis", () => {
  const h = harness();
  h.self.onIntent({ dirX: 1, dirY: 1, running: false });
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0);
  assert.deepEqual(h.moves.at(-1), { dirX: 1, dirY: 1, running: false });
  assert.deepEqual({ dirX: h.self.facing.dirX, dirY: h.self.facing.dirY }, { dirX: 1, dirY: 0 });
});

test("waiting against a blocking Hog sends one standing face update", () => {
  const h = harness();
  h.hogTiles.add("1,0");
  h.self.onIntent(right);
  h.self.update(h.entry, h.motion(0, 0, 0, 0), 0);
  h.self.update(h.entry, h.motion(0, 0, 0, 0), 16);
  assert.equal(h.moves.length, 0);
  assert.deepEqual(h.faces, [{ dirX: 1, dirY: 0 }]);
});

test("a held run re-bases the origin once per tile crossed", () => {
  const h = harness();
  h.self.onIntent(right, true); // sends the initial move(right), origin tile (0,0)
  h.moves.length = 0;
  h.self.update(h.entry, h.motion(0.05, 0, 1, 0), 0); // same tile, no re-base
  h.self.update(h.entry, h.motion(0.49, 0, 1, 0), 1); // still nearest tile 0
  assert.equal(h.moves.length, 0);
  h.self.update(h.entry, h.motion(1, 0, 1, 0), 2); // now on tile 1 → re-base
  assert.deepEqual(h.moves.at(-1), right);
  assert.equal(h.moves.length, 1); // once per crossing, not per frame
  h.self.update(h.entry, h.motion(1.2, 0, 1, 0), 3);
  assert.equal(h.moves.length, 1);
});

test("walking flush into a Hog stops the trogg, keeping it idle (no stale intent)", () => {
  const h = harness();
  h.self.onIntent(right, true);
  h.moves.length = 0;
  h.hogTiles.add("1,0"); // Hog on the tile directly ahead
  h.self.update(h.entry, h.motion(0, 0, 1, 0), 0); // flush on centre against the Hog
  assert.deepEqual(h.moves.at(-1), { dirX: 0, dirY: 0, running: false });
});

test("a server settle near the optimistic origin acks it — clock drift is not a snap", () => {
  const h = harness();
  h.self.onIntent(right, true); // optimistic move(right) from (0,0)
  const predictedBaseMs = h.entry.baseMs;
  // The server derived the same trajectory on its own clock: same heading, slightly
  // different fractional origin (latency × speed).
  const server = { x: 0.42, y: 0, dirX: 1, dirY: 0, faceX: 1, faceY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 5n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  assert.equal(h.entry.player.x, 0); // local prediction kept
  assert.equal(h.entry.baseMs, predictedBaseMs); // no animation restart
});

test("a server motion far from the optimistic origin still snaps to authority", () => {
  const h = harness();
  h.self.onIntent(right, true);
  const server = { x: 7, y: 3, dirX: 1, dirY: 0, faceX: 1, faceY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 5n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  assert.equal(h.entry.player.x, 7); // genuine disagreement → server truth
  assert.equal(h.entry.baseMs, 1000); // re-based to the server stamp
});

test("a server row that matches a pending move is an ack, not a snap", () => {
  const h = harness();
  h.self.onIntent(right, true); // optimistic move(right) from (0,0)
  const server = { x: 0, y: 0, dirX: 1, dirY: 0, faceX: 1, faceY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 5n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  // Predicted motion is kept (intent stays right); baseMs is NOT reset to the server stamp.
  assert.equal(h.entry.player.dirX, 1);
  assert.notEqual(h.entry.baseMs, 1000);
});

test("a stale non-motion self row does not snap over pending local movement", () => {
  const h = harness();
  h.self.onIntent(right, true); // optimistic move(right), server has not acked it yet
  const predictedBaseMs = h.entry.baseMs;
  const server = {
    x: 0,
    y: 0,
    dirX: 0,
    dirY: 0,
    faceX: 0,
    faceY: 1,
    running: false,
    path: "",
    movedAt: { microsSinceUnixEpoch: 0n },
    equipmentAction: "sword",
    equipmentActionAt: { microsSinceUnixEpoch: 9n },
  } as unknown as Player;

  h.self.reconcile(h.entry, server);

  assert.deepEqual({ x: h.entry.player.x, y: h.entry.player.y, dirX: h.entry.player.dirX, dirY: h.entry.player.dirY }, { x: 0, y: 0, dirX: 1, dirY: 0 });
  assert.equal(h.entry.player.equipmentAction, "sword");
  assert.equal(h.entry.baseMs, predictedBaseMs);
});

test("a server row that matches nothing snaps to authority", () => {
  const h = harness();
  const server = { x: 7, y: 3, dirX: 0, dirY: 0, faceX: 0, faceY: -1, running: false, path: "", movedAt: { microsSinceUnixEpoch: 9n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  assert.equal(h.entry.player.x, 7);
  assert.equal(h.entry.player.y, 3);
  assert.deepEqual({ dirX: h.self.facing.dirX, dirY: h.self.facing.dirY }, { dirX: 0, dirY: -1 });
  assert.equal(h.entry.baseMs, 1000); // re-based to the server stamp via toBaseMs
});

test("an idle duplicate tab observing WASD movement does not send a stop", () => {
  const h = harness();
  const server = { x: 0, y: 0, dirX: 1, dirY: 0, faceX: 1, faceY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 9n } } as unknown as Player;
  h.self.reconcile(h.entry, server); // another tab started walking this shared trogg
  h.self.update(h.entry, h.motion(1, 0, 1, 0), 1000); // observer reaches a tile centre
  assert.equal(h.moves.length, 0);
});

test("a duplicate tab observes silently, then takes over on local keyboard input", () => {
  const h = harness();
  const server = { x: 0, y: 0, dirX: 1, dirY: 0, faceX: 1, faceY: 0, running: false, path: "", movedAt: { microsSinceUnixEpoch: 9n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  h.self.update(h.entry, h.motion(1, 0, 1, 0), 500); // observing another tab's motion
  assert.equal(h.moves.length, 0);
  h.self.onIntent(down); // local input → this tab drives now
  h.self.update(h.entry, h.motion(1, 0, 1, 0), 1000);
  assert.deepEqual(h.moves.at(-1), down);
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

test("rapid clicks on the same tile don't re-route until the first is acked", () => {
  const h = harness();
  h.self.onClick({ x: 4, y: 0 });
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // idle, centred → fires the first moveTo
  assert.equal(h.moveTos.length, 1);
  h.self.onClick({ x: 4, y: 0 }); // clicked again before the server answers
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 16); // still idle, ack not back yet
  assert.equal(h.moveTos.length, 1); // no duplicate route — a second would reset movedAt and rewind for everyone
});

test("re-clicking the tile we're already routing to is ignored (no re-path snap)", () => {
  const h = harness();
  h.self.onClick({ x: 4, y: 0 });
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // fires the route
  // Server answers: trogg now pathing east toward (4,0) from (0,0).
  const server = { x: 0, y: 0, dirX: 1, dirY: 0, faceX: 1, faceY: 0, running: false, path: "1,0;2,0;3,0;4,0", movedAt: { microsSinceUnixEpoch: 5n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  h.moveTos.length = 0;
  h.self.onClick({ x: 4, y: 0 }); // same destination, mid-route
  h.self.update(h.entry, h.motion(0.5, 0, 1, 0), 50); // mid-tile (prev becomes non-NaN)
  h.self.update(h.entry, h.motion(1, 0, 1, 0), 100); // crosses a real centre — where a redirect would re-route
  assert.equal(h.moveTos.length, 0); // deduped — re-routing would reset movedAt and snap the trogg
});

test("redirecting mid-route re-routes immediately from the fractional spot", () => {
  const h = harness();
  h.self.onClick({ x: 4, y: 0 });
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // fires the first moveTo
  // Server answers: trogg now pathing east toward (4,0) from (0,0).
  const server = { x: 0, y: 0, dirX: 1, dirY: 0, faceX: 1, faceY: 0, running: false, path: "1,0;2,0;3,0;4,0", movedAt: { microsSinceUnixEpoch: 5n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  h.moveTos.length = 0;
  h.self.onClick({ x: 4, y: 2 }); // redirect to a different tile mid-glide
  h.self.update(h.entry, h.motion(0.4, 0, 1, 0), 32); // free movement banks nothing → fire now
  assert.deepEqual(h.moveTos.at(-1), { x: 4, y: 2 });
  assert.equal(h.moveTos.length, 1);
});

test("clicking a tile we're already on clears the marker instead of retrying forever", () => {
  const h = harness();
  h.self.onClick({ x: 0, y: 0 }); // our own tile
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // flushes the (no-op) moveTo
  // Server answers with an empty path (findPath returns [] for the current tile).
  const server = { x: 0, y: 0, dirX: 0, dirY: 0, faceX: 0, faceY: 1, running: false, path: "", movedAt: { microsSinceUnixEpoch: 1n } } as unknown as Player;
  h.self.reconcile(h.entry, server);
  const before = h.moveTos.length;
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 1000); // well past the retry throttle
  assert.equal(h.destinations.at(-1), undefined); // marker cleared
  assert.equal(h.moveTos.length, before); // no further moveTo spam
});

test("WASD resumes the held direction once a blocking Hog moves off", () => {
  const h = harness();
  h.self.onIntent(right, true); // walking right
  h.hogTiles.add("1,0"); // Hog flush on the tile ahead
  h.self.update(h.entry, h.motion(0, 0, 1, 0), 0); // stop flush against it (idle intent)
  h.moves.length = 0;
  h.self.update(h.entry, h.motion(0, 0, 0, 0), 16); // still blocked: wait, arm the resume
  assert.equal(h.moves.length, 0);
  h.hogTiles.clear(); // Hog ambles off
  h.self.update(h.entry, h.motion(0, 0, 0, 0), 32); // tile clear → resume walking
  assert.deepEqual(h.moves.at(-1), right);
});

test("a click-to-move route stalled on a Hog re-issues toward the clicked tile", () => {
  const h = harness();
  h.self.onClick({ x: 5, y: 0 });
  h.self.update(h.entry, h.motion(0, 0, 0, 0, true), 0); // flush fires the initial moveTo
  h.moveTos.length = 0;
  // Server routed us partway, then a Hog sealed the next tile: path set, no heading, not arrived.
  h.entry.player.path = "1,0;2,0;3,0;4,0;5,0";
  h.self.update(h.entry, h.motion(1, 0, 0, 0, false), 1000); // stalled, throttle elapsed → re-route
  assert.deepEqual(h.moveTos.at(-1), { x: 5, y: 0 });
});
