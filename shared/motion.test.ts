import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_SPEED_TILES_PER_SEC } from "./constants";
import { projectMotion } from "./motion";

const zone = { width: 24, height: 16 };

test("idle motion stays at the origin regardless of elapsed time", () => {
  const at = projectMotion({ x: 5, y: 5, dirX: 0, dirY: 0 }, 10_000, zone);
  assert.deepEqual(at, { x: 5, y: 5 });
});

test("moving advances the origin by speed × elapsed along the direction", () => {
  const at = projectMotion({ x: 2, y: 5, dirX: 1, dirY: 0 }, 1_000, zone);
  assert.equal(at.x, 2 + MOVE_SPEED_TILES_PER_SEC);
  assert.equal(at.y, 5);
});

test("a diagonal direction is normalised so it isn't faster than an axis", () => {
  const at = projectMotion({ x: 0, y: 0, dirX: 1, dirY: 1 }, 1_000, zone);
  const dist = Math.hypot(at.x, at.y);
  assert.ok(Math.abs(dist - MOVE_SPEED_TILES_PER_SEC) < 1e-9);
});

test("position is clamped to the zone bounds", () => {
  const at = projectMotion({ x: 23, y: 5, dirX: 1, dirY: 0 }, 10_000, zone);
  assert.equal(at.x, zone.width - 1);
});
