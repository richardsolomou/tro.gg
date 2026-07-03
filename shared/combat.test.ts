import assert from "node:assert/strict";
import { test } from "node:test";
import { meleeHit, MELEE_POINT_BLANK_TILES, MELEE_RANGE_TILES } from "./combat";

const circle = (x: number, y: number, radius = 0.45) => ({ x, y, radius });

test("a swing hits a target dead ahead inside reach", () => {
  assert.ok(meleeHit(0, 0, 0, 1000, circle(0, 1.5)) !== undefined);
});

test("reach measures to the hit-circle edge, not the centre", () => {
  assert.ok(meleeHit(0, 0, 0, 1000, circle(0, MELEE_RANGE_TILES + 0.4)) !== undefined);
  assert.equal(meleeHit(0, 0, 0, 1000, circle(0, MELEE_RANGE_TILES + 0.5)), undefined);
});

test("a target outside the swing cone is a miss", () => {
  assert.equal(meleeHit(0, 0, 0, 1000, circle(1.5, 0)), undefined); // 90° off aim
});

test("an off-axis target inside the cone is a hit", () => {
  assert.ok(meleeHit(0, 0, 707, 707, circle(0.9, 1.1)) !== undefined); // ~8° off a diagonal aim
});

test("point blank waives the angle check", () => {
  assert.ok(meleeHit(0, 0, 0, 1000, circle(0, -MELEE_POINT_BLANK_TILES + 0.05)) !== undefined);
});

test("a big hit circle widens the cone by what it subtends", () => {
  // centre ~64° off aim — outside the 55° cone — but the 1.0 radius overlaps it
  assert.ok(meleeHit(0, 0, 0, 1000, { x: 1.15, y: 0.55, radius: 1.0 }) !== undefined);
  assert.equal(meleeHit(0, 0, 0, 1000, { x: 1.15, y: 0.55, radius: 0.2 }), undefined);
});

test("a zero aim vector only lands point-blank hits", () => {
  assert.equal(meleeHit(0, 0, 0, 0, circle(0, 1.5)), undefined);
  assert.ok(meleeHit(0, 0, 0, 0, circle(0, 0.5)) !== undefined);
});
