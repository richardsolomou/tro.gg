import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLOR_UNSET,
  STYLE_UNSET,
  isColorIndex,
  isTroggStyleIndex,
  TROGG_COLORS,
  troggColor,
  troggColorFor,
  troggColorIndexFor,
  troggStyle,
  troggStyleFor,
  troggStyleIndexFor,
} from "./avatar";
import { TROGG_STYLES } from "./creatures";

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

test("a trogg's style is stable for the same id and always from the list", () => {
  assert.equal(troggStyle("abcd1234"), troggStyle("abcd1234"));
  for (const id of ["a", "trogg-0001", "ffffffff", ""]) {
    assert.ok((TROGG_STYLES as readonly string[]).includes(troggStyle(id)));
  }
});

test("only in-range integers are selectable style indices", () => {
  assert.ok(isTroggStyleIndex(0));
  assert.ok(isTroggStyleIndex(TROGG_STYLES.length - 1));
  assert.ok(!isTroggStyleIndex(STYLE_UNSET));
  assert.ok(!isTroggStyleIndex(TROGG_STYLES.length));
  assert.ok(!isTroggStyleIndex(1.5));
});

test("a chosen style index resolves to its entry, unchosen to the id default", () => {
  for (let i = 0; i < TROGG_STYLES.length; i++) assert.equal(troggStyleFor(i, "any-id"), TROGG_STYLES[i]);
  assert.equal(troggStyleFor(STYLE_UNSET, "abcd1234"), troggStyle("abcd1234"));
});

test("effective index resolvers fall back to the id-derived default when unchosen", () => {
  // chosen index passes through
  assert.equal(troggColorIndexFor(3, "abcd1234"), 3);
  assert.equal(troggStyleIndexFor(2, "abcd1234"), 2);
  // unset resolves to a default index whose entry matches the value resolvers
  const cIdx = troggColorIndexFor(COLOR_UNSET, "abcd1234");
  assert.equal(TROGG_COLORS[cIdx], troggColorFor(COLOR_UNSET, "abcd1234"));
  const sIdx = troggStyleIndexFor(STYLE_UNSET, "abcd1234");
  assert.equal(TROGG_STYLES[sIdx], troggStyleFor(STYLE_UNSET, "abcd1234"));
});
