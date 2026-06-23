import assert from "node:assert/strict";
import { test } from "node:test";
import { COLOR_UNSET, isColorIndex, TROGG_COLORS, troggColor, troggColorFor } from "./avatar";

test("a trogg's colour is stable for the same id", () => {
  assert.equal(troggColor("abcd1234"), troggColor("abcd1234"));
});

test("the colour is always drawn from the palette", () => {
  for (const id of ["a", "trogg-0001", "ffffffff", ""]) {
    assert.ok(TROGG_COLORS.includes(troggColor(id) as (typeof TROGG_COLORS)[number]));
  }
});

test("different ids can map to different colours", () => {
  const colours = new Set(["a1", "b2", "c3", "d4", "e5", "f6"].map(troggColor));
  assert.ok(colours.size > 1);
});

test("only in-range integers are selectable palette indices", () => {
  assert.ok(isColorIndex(0));
  assert.ok(isColorIndex(TROGG_COLORS.length - 1));
  assert.ok(!isColorIndex(COLOR_UNSET));
  assert.ok(!isColorIndex(TROGG_COLORS.length));
  assert.ok(!isColorIndex(1.5));
});

test("a chosen index resolves to its palette entry", () => {
  for (let i = 0; i < TROGG_COLORS.length; i++) {
    assert.equal(troggColorFor(i, "any-id"), TROGG_COLORS[i]);
  }
});

test("an unchosen colour falls back to the id-derived default", () => {
  assert.equal(troggColorFor(COLOR_UNSET, "abcd1234"), troggColor("abcd1234"));
  assert.equal(troggColorFor(TROGG_COLORS.length, "abcd1234"), troggColor("abcd1234"));
});
