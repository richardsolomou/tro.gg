import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertZones,
  getZone,
  wieldOf,
  isGeneratedName,
  isValidName,
  isWalkable,
  STARTING_ZONE_SLUG,
  TILE_GLYPHS,
  WALL_TILE,
  ZONES,
} from "./constants";

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

test("every zone's tilemap matches its declared dimensions", () => {
  assert.doesNotThrow(assertZones);
});

test("only the wall glyph is unwalkable; decorative floor glyphs stay walkable", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  for (const [y, row] of zone.tiles.entries()) {
    for (let x = 0; x < row.length; x++) {
      assert.equal(isWalkable(zone, x, y), row[x] !== WALL_TILE, `tile (${x}, ${y}) glyph ${row[x]}`);
    }
  }
});

test("the starting zone uses several decorative tile glyphs for variety", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  const used = new Set([...zone.tiles.join("")]);
  // wall, plain floor, plus at least three decorative variants in the mix.
  assert.ok(used.size >= 5, `expected a varied tilemap, saw glyphs: ${[...used].join("")}`);
  for (const glyph of used) assert.ok(TILE_GLYPHS.has(glyph), `unknown glyph ${JSON.stringify(glyph)}`);
});

test("assertZones rejects an unknown tile glyph", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  // Inject a zone whose tilemap has a stray glyph, then assert the guard catches it.
  ZONES["__broken__"] = { ...zone, slug: "__broken__", tiles: zone.tiles.map((r, i) => (i === 1 ? "Z" + r.slice(1) : r)) };
  try {
    assert.throws(assertZones, /unknown tile glyph/);
  } finally {
    delete ZONES["__broken__"];
  }
});

test("the zone rim is walled and the interior is floor", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  assert.equal(isWalkable(zone, 0, 0), false); // corner rim
  assert.equal(isWalkable(zone, 12, 8), true); // spawn (zone centre)
  assert.equal(isWalkable(zone, -1, 5), false); // out of bounds is unwalkable
  assert.equal(isWalkable(zone, zone.width, 5), false);
});

test("the starting zone seeds boulders on floor, clear of the spawn", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  assert.ok(zone.boulders.length > 0);
  const spawn = { x: Math.floor(zone.width / 2), y: Math.floor(zone.height / 2) };
  for (const b of zone.boulders) {
    assert.equal(isWalkable(zone, b.x, b.y), true);
    assert.ok(b.x !== spawn.x || b.y !== spawn.y, "boulder must not sit on the spawn tile");
  }
});

test("the starting zone seeds roaming hogs on walkable floor", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  assert.ok(zone.hogs.length > 0);
  for (const h of zone.hogs) assert.equal(isWalkable(zone, h.x, h.y), true);
});

test("the starting zone seeds pickup items on walkable floor", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  assert.ok(zone.items.length > 0);
  for (const item of zone.items) assert.equal(isWalkable(zone, item.x, item.y), true);
});

test("wieldOf maps weapons to their attack class and everything else to the bare swing", () => {
  assert.equal(wieldOf("sword"), "stab");
  assert.equal(wieldOf("pickaxe"), "chop");
  assert.equal(wieldOf("shovel"), "scoop");
  assert.equal(wieldOf("shield"), "swing");
  assert.equal(wieldOf(""), "swing");
  assert.equal(wieldOf("not-an-item"), "swing");
});
