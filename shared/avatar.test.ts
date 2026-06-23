import assert from "node:assert/strict";
import { test } from "node:test";
import { TROGG_COLORS, troggColor } from "./avatar";

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
