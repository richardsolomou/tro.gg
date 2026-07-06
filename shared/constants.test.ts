import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertZones,
  blockFractionOf,
  getZone,
  isRevealed,
  penumbraOf,
  SHIELD_BLOCK_FRACTION,
  wieldOf,
  isGeneratedName,
  isValidName,
  isWalkable,
  SOLID_GLYPHS,
  STARTING_ZONE_SLUG,
  TILE_GLYPHS,
  tileGlyph,
  ZONES,
} from "./constants";
import { capitalOf, neighborsOf, regionSeeds, regionSlug } from "./worldgen";

test("the starting zone resolves from the registry", () => {
  const zone = getZone(STARTING_ZONE_SLUG);
  assert.ok(zone);
  assert.equal(zone.slug, STARTING_ZONE_SLUG);
  assert.ok(zone.unbounded, "the world has no edge");
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

test("only the solid glyphs (rock, deep water) are unwalkable, sampled around the spawn", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  const spawn = zone.spawn!;
  for (let y = spawn.y - 40; y < spawn.y + 40; y++) {
    for (let x = spawn.x - 40; x < spawn.x + 40; x++) {
      const glyph = tileGlyph(zone, x, y)!;
      assert.equal(isWalkable(zone, x, y), !SOLID_GLYPHS.has(glyph), `tile (${x}, ${y}) glyph ${glyph}`);
    }
  }
});

test("the world synthesizes several decorative tile glyphs for variety", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  const spawn = zone.spawn!;
  const used = new Set<string>();
  for (let y = spawn.y - 60; y < spawn.y + 60; y++) {
    for (let x = spawn.x - 60; x < spawn.x + 60; x++) used.add(tileGlyph(zone, x, y)!);
  }
  // wall, plain floor, plus at least three decorative variants in the mix.
  assert.ok(used.size >= 5, `expected a varied tilemap, saw glyphs: ${[...used].join("")}`);
  for (const glyph of used) assert.ok(TILE_GLYPHS.has(glyph), `unknown glyph ${JSON.stringify(glyph)}`);
});

test("assertZones rejects an unknown tile glyph", () => {
  const cave = getZone("birthcave")!;
  // Inject a zone whose tilemap has a stray glyph, then assert the guard catches it.
  ZONES["__broken__"] = { ...cave, slug: "__broken__", tiles: cave.tiles.map((r, i) => (i === 1 ? "Z" + r.slice(1) : r)) };
  try {
    assert.throws(assertZones, /unknown tile glyph/);
  } finally {
    delete ZONES["__broken__"];
  }
});

test("a bounded zone clamps at its rim; the world's spawn plaza is open", () => {
  const cave = getZone("birthcave")!;
  assert.equal(isWalkable(cave, 0, 0), false); // corner rim
  assert.equal(isWalkable(cave, -1, 5), false); // out of bounds is unwalkable
  assert.equal(isWalkable(cave, cave.width, 5), false);
  const world = getZone(STARTING_ZONE_SLUG)!;
  assert.equal(isWalkable(world, world.spawn!.x, world.spawn!.y), true); // the spawn plaza
});

test("the hearth's region seeds land on floor, clear of the spawn", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  const seeds = regionSeeds("hearth");
  assert.ok(seeds.boulders.length > 0);
  const spawn = zone.spawn!;
  for (const b of seeds.boulders) {
    assert.equal(isWalkable(zone, b.x, b.y), true);
    assert.ok(b.x !== spawn.x || b.y !== spawn.y, "boulder must not sit on the spawn tile");
  }
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

test("blockFractionOf only credits the shield's toughness stat", () => {
  assert.equal(blockFractionOf("shield"), SHIELD_BLOCK_FRACTION);
  assert.equal(blockFractionOf("sword"), 0);
  assert.equal(blockFractionOf("torch"), 0);
  assert.equal(blockFractionOf(""), 0);
  assert.equal(blockFractionOf("not-an-item"), 0);
});

test("penumbraOf returns a revealed region's unclaimed neighbours", () => {
  const revealed = new Set(["hearth"]);
  assert.deepEqual([...penumbraOf(revealed)].sort(), [...neighborsOf("hearth")].sort());
});

test("penumbraOf never re-includes an already-revealed region", () => {
  const claimedNeighbor = regionSlug(1, 0);
  const revealed = new Set(["hearth", claimedNeighbor]);
  const penumbra = penumbraOf(revealed);
  assert.ok(!penumbra.has("hearth"));
  assert.ok(!penumbra.has(claimedNeighbor));
  assert.ok(penumbra.has(regionSlug(0, 1))); // a hearth neighbour not yet claimed
  assert.ok(penumbra.has(regionSlug(2, 0))); // exposed by the claimed neighbour
});

test("isRevealed treats interior and penumbra ground as revealed, everything else as a hard wall", () => {
  const zone = getZone(STARTING_ZONE_SLUG)!;
  const revealed = new Set(["hearth"]);
  const penumbra = penumbraOf(revealed);
  assert.equal(isRevealed(zone, revealed, penumbra, zone.spawn!.x, zone.spawn!.y), true); // interior
  // two cells out is beyond the hearth's penumbra, however the borders warp
  const unreached = capitalOf(3, 3);
  assert.equal(isRevealed(zone, revealed, penumbra, unreached.x, unreached.y), false);
});

test("isRevealed is always true outside the world zone", () => {
  const cave = getZone("birth:deadbeef")!;
  assert.equal(isRevealed(cave, new Set(), new Set(), 0, 0), true);
});
