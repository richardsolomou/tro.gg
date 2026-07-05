import assert from "node:assert/strict";
import test from "node:test";
import { WORLD_RING_WIDTH, frontlineRing, penumbraRing, worldRingAt, worldRingSeed } from "./index";

const origin = { x: 10, y: 10 };

test("world rings are deterministic radial bands", () => {
  assert.equal(worldRingAt(origin, 10, 10), 0);
  assert.equal(worldRingAt(origin, 10 + WORLD_RING_WIDTH - 1, 10), 0);
  assert.equal(worldRingAt(origin, 10 + WORLD_RING_WIDTH, 10), 1);
  assert.equal(worldRingSeed(3), worldRingSeed(3));
  assert.notEqual(worldRingSeed(3), worldRingSeed(4));
});

test("the generated penumbra stays exactly one ring beyond lit reach", () => {
  const sources = [{ zoneId: "world", x: 10, y: 10, radius: WORLD_RING_WIDTH, lit: true }];
  assert.equal(frontlineRing(origin, sources, "world"), 1);
  assert.equal(penumbraRing(origin, sources, "world"), 2);
});
