import assert from "node:assert/strict";
import { test } from "node:test";
import { getZone, isGeneratedName, isValidName, STARTING_ZONE_SLUG } from "./constants";

test("the starting zone resolves from the registry", () => {
  const zone = getZone(STARTING_ZONE_SLUG);
  assert.ok(zone);
  assert.equal(zone.slug, STARTING_ZONE_SLUG);
  assert.ok(zone.width > 0 && zone.height > 0);
});

test("an unknown slug resolves to undefined", () => {
  assert.equal(getZone("no-such-zone"), undefined);
});

test("a valid name is 3–20 chars of letters, numbers, or hyphens", () => {
  assert.ok(isValidName("mossback"));
  assert.ok(isValidName("trogg-9f3a"));
  assert.ok(isValidName("a-1"));
  assert.ok(isValidName("x".repeat(20)));
});

test("an invalid name is rejected on length or characters", () => {
  assert.ok(!isValidName("ab")); // too short
  assert.ok(!isValidName("x".repeat(21))); // too long
  assert.ok(!isValidName("has space"));
  assert.ok(!isValidName("emoji🦔"));
  assert.ok(!isValidName("under_score"));
});

test("a generated guest name is trogg- plus four hex of the identity", () => {
  assert.ok(isGeneratedName("trogg-9f3a"));
  assert.ok(isGeneratedName("trogg-0000"));
  // A name the player chose is not treated as generated, so a claim won't discard it.
  assert.ok(!isGeneratedName("trogg-cool"));
  assert.ok(!isGeneratedName("mossback"));
  assert.ok(!isGeneratedName("trogg-9f3"));
});
