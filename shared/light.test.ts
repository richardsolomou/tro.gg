import assert from "node:assert/strict";
import { test } from "node:test";
import { isTileLit, litTileKeys, tileKey } from "./index";

const fires = [
  { zoneId: "world", x: 10, y: 10, radius: 2, lit: true },
  { zoneId: "world", x: 20, y: 20, radius: 4, lit: false },
  { zoneId: "birth:one", x: 1, y: 1, radius: 8, lit: true },
];

test("lit tiles are the union of burning hearth radii in one zone", () => {
  assert.equal(isTileLit(fires, "world", 10, 10), true);
  assert.equal(isTileLit(fires, "world", 12, 10), true);
  assert.equal(isTileLit(fires, "world", 13, 10), false);
  assert.equal(isTileLit(fires, "world", 20, 20), false);
  assert.equal(isTileLit(fires, "birth:one", 1, 1), true);
});

test("litTileKeys builds the collision set dark creatures must avoid", () => {
  const tiles = litTileKeys(fires, "world", 24, 24);
  assert.equal(tiles.has(tileKey(10, 10)), true);
  assert.equal(tiles.has(tileKey(12, 10)), true);
  assert.equal(tiles.has(tileKey(13, 10)), false);
  assert.equal(tiles.has(tileKey(20, 20)), false);
});
