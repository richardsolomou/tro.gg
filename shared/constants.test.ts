import assert from "node:assert/strict";
import { test } from "node:test";
import { getZone, STARTING_ZONE_SLUG } from "./constants";

test("the starting zone resolves from the registry", () => {
  const zone = getZone(STARTING_ZONE_SLUG);
  assert.ok(zone);
  assert.equal(zone.slug, STARTING_ZONE_SLUG);
  assert.ok(zone.width > 0 && zone.height > 0);
});

test("an unknown slug resolves to undefined", () => {
  assert.equal(getZone("no-such-zone"), undefined);
});
