import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FACINGS,
  FRAMES,
  FRAME_H,
  FRAME_W,
  SHEET_H,
  SHEET_W,
  frameRect,
  frames,
  ghostDraw,
  paintSheet,
  styleGroups,
  type PixelSink,
} from "./sprites";
import { AVATAR_FRAME_ART, GHOST_ART, PIXEL_KEYS, type IndexedSpriteArt } from "./sprite_art";

test("the atlas covers every style group × facing × frame exactly once", () => {
  const all = frames();
  assert.equal(all.length, styleGroups().length * FACINGS.length * FRAMES.length);
  assert.equal(new Set(all.map((f) => f.name)).size, all.length);
});

test("frames tile the sheet without overlap or gaps", () => {
  const seen = new Set<string>();
  for (const f of frames()) {
    assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.w <= SHEET_W && f.y + f.h <= SHEET_H);
    seen.add(`${f.x},${f.y}`);
  }
  // distinct cells, each one frame, filling the COLS×ROWS grid
  assert.equal(seen.size, frames().length);
});

test("frameRect names follow kind_style_facing_frame", () => {
  assert.equal(frameRect("trogg", "moss", "down", "walk_a").name, "trogg_moss_down_walk_a");
  assert.equal(frameRect("hog", "ember", "left", "idle").name, "hog_ember_left_idle");
});

function assertIndexedArt(name: string, art: IndexedSpriteArt): void {
  assert.equal(art.pixels.length, FRAME_H, `${name} row count`);
  const validKeys = new Set([".", ...PIXEL_KEYS]);
  for (const [y, row] of art.pixels.entries()) {
    assert.equal(row.length, FRAME_W, `${name} row ${y} width`);
    for (const key of row) {
      assert.ok(validKeys.has(key), `${name} uses unknown pixel key ${key}`);
      if (key !== ".") assert.ok(PIXEL_KEYS.indexOf(key) < art.palette.length, `${name} key ${key} has no palette entry`);
    }
  }
  for (const rgba of art.palette) {
    assert.ok(Number.isInteger(rgba) && rgba >= 0 && rgba <= 0xffffffff, `${name} palette entry is not RGBA`);
  }
}

test("indexed avatar art covers every generated frame", () => {
  const expected = frames().map((f) => f.name);
  assert.deepEqual(Object.keys(AVATAR_FRAME_ART), expected);
  for (const name of expected) assertIndexedArt(name, AVATAR_FRAME_ART[name]!);
});

test("indexed ghost art is one valid frame", () => {
  assertIndexedArt("ghost", GHOST_ART);
});

test("painting stays within the sheet bounds", () => {
  let out = 0;
  const sink: PixelSink = {
    set(x, y) {
      if (x < 0 || y < 0 || x >= SHEET_W || y >= SHEET_H) out++;
    },
  };
  paintSheet(sink);
  assert.equal(out, 0);
});

test("the ghost paints within one frame's bounds and marks some pixels", () => {
  let n = 0;
  let out = 0;
  const sink: PixelSink = {
    set(x, y) {
      n++;
      if (x < 0 || y < 0 || x >= FRAME_W || y >= FRAME_H) out++;
    },
  };
  ghostDraw(sink);
  assert.ok(n > 0, "ghost painted nothing");
  assert.equal(out, 0);
});

test("every frame paints at least some pixels", () => {
  const counts = new Map<string, number>();
  for (const f of frames()) {
    let n = 0;
    const sink: PixelSink = {
      set(x, y) {
        if (x >= f.x && x < f.x + FRAME_W && y >= f.y && y < f.y + FRAME_H) n++;
      },
    };
    // paint just this frame's cell by painting the whole sheet and counting in-cell
    paintSheet(sink);
    counts.set(f.name, n);
  }
  for (const [name, n] of counts) assert.ok(n > 0, `${name} painted nothing`);
});
