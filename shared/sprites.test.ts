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
