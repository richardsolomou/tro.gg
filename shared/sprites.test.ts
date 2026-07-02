import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FACINGS,
  FRAMES,
  FRAME_H,
  FRAME_W,
  RUN_PHASE_MS,
  SHEET_H,
  SHEET_W,
  WALK_PHASE_MS,
  avatarFrame,
  frameRect,
  frames,
  blitArt,
  ghostDraw,
  paintSheet,
  styleGroups,
  type PixelSink,
} from "./sprites";
import { AVATAR_FRAME_ART, GHOST_ART, PIXEL_KEYS, type IndexedSpriteArt } from "./sprite_art";
import { ITEM_ART, ITEM_ART_H, ITEM_ART_W } from "./item_art";

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

test("standing still is the idle frame", () => {
  assert.equal(avatarFrame(false, false, 0), "idle");
  assert.equal(avatarFrame(false, true, 12_345), "idle");
});

test("the walk is a four-phase stride: step, passing pose, other step, passing pose", () => {
  const at = (phase: number) => avatarFrame(true, false, phase * WALK_PHASE_MS);
  assert.deepEqual([at(0), at(1), at(2), at(3)], ["walk_a", "idle", "walk_b", "idle"]);
  // and it cycles
  assert.equal(at(4), "walk_a");
});

test("the run shares the cycle on its own faster steps", () => {
  const at = (phase: number) => avatarFrame(true, true, phase * RUN_PHASE_MS);
  assert.deepEqual([at(0), at(1), at(2), at(3)], ["run_a", "idle", "run_b", "idle"]);
  assert.ok(RUN_PHASE_MS < WALK_PHASE_MS, "running strides quicker than walking");
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

test("item art covers the tools, stone, and boulder as valid maps", () => {
  for (const name of ["pickaxe", "shovel", "sword", "stone", "boulder"]) {
    assert.ok(ITEM_ART[name], `missing item art for ${name}`);
  }
  const validKeys = new Set([".", ...PIXEL_KEYS]);
  for (const [name, art] of Object.entries(ITEM_ART)) {
    assert.equal(art.pixels.length, ITEM_ART_H, `${name} row count`);
    for (const [y, row] of art.pixels.entries()) {
      assert.equal(row.length, ITEM_ART_W, `${name} row ${y} width`);
      for (const key of row) {
        assert.ok(validKeys.has(key), `${name} uses unknown pixel key ${key}`);
        if (key !== ".") assert.ok(PIXEL_KEYS.indexOf(key) < art.palette.length, `${name} key ${key} has no palette entry`);
      }
    }
    for (const rgba of art.palette) {
      assert.ok(Number.isInteger(rgba) && rgba >= 0 && rgba <= 0xffffffff, `${name} palette entry is not RGBA`);
    }
  }
});

test("blitArt paints an item within its own bounds", () => {
  let painted = 0;
  let out = 0;
  const sink: PixelSink = {
    set(x, y) {
      painted++;
      if (x < 0 || y < 0 || x >= ITEM_ART_W || y >= ITEM_ART_H) out++;
    },
  };
  blitArt(sink, ITEM_ART.boulder!);
  assert.ok(painted > 0, "boulder painted nothing");
  assert.equal(out, 0);
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
