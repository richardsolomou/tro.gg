import { test } from "node:test";
import assert from "node:assert/strict";

import { attackEase, FLINCH_MS, flinchPose, STRIKE_PEAK } from "../src/game/equipment.ts";

test("attackEase is a fast wind-up to the strike, then a slower recovery", () => {
  assert.equal(attackEase(0), 0);
  assert.equal(attackEase(1), 0);
  // peaks at the strike
  assert.ok(Math.abs(attackEase(STRIKE_PEAK) - 1) < 1e-9, "should reach full strike at STRIKE_PEAK");
  // rises to the peak, then falls away from it
  assert.ok(attackEase(STRIKE_PEAK / 2) < attackEase(STRIKE_PEAK));
  assert.ok(attackEase(STRIKE_PEAK + (1 - STRIKE_PEAK) / 2) < attackEase(STRIKE_PEAK));
  // the recovery is slower than the wind-up: still well off rest a third of the way back
  assert.ok(attackEase(STRIKE_PEAK + (1 - STRIKE_PEAK) / 3) > 0.6);
});

test("flinchPose recoils out and back, flashes early, then finishes", () => {
  assert.equal(flinchPose(-1), null);
  assert.equal(flinchPose(FLINCH_MS), null);
  const start = flinchPose(1)!;
  const mid = flinchPose(FLINCH_MS / 2)!;
  const end = flinchPose(FLINCH_MS - 1)!;
  assert.ok(mid.shove > start.shove && mid.shove > end.shove, "shove peaks mid-flinch");
  assert.ok(Math.abs(mid.shove - 1) < 1e-6, "shove reaches full at the midpoint");
  assert.equal(start.flash, true, "flashes at the start");
  assert.equal(mid.flash, false, "flash is over by the midpoint");
});
