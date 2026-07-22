import assert from "node:assert/strict";
import test from "node:test";
import { atFirstFire } from "../shared/crafting";

const firstFire = { x: 10, y: 10, radius: 4, lit: true, isEternal: true };

test("crafting is available within the First Fire's light", () => {
  assert.equal(atFirstFire({ x: 13, y: 10 }, [firstFire]), true);
});

test("crafting is unavailable outside the First Fire's light", () => {
  assert.equal(atFirstFire({ x: 15, y: 10 }, [firstFire]), false);
});

test("an ordinary brazier is not a crafting station", () => {
  assert.equal(atFirstFire({ x: 10, y: 10 }, [{ ...firstFire, isEternal: false }]), false);
});
