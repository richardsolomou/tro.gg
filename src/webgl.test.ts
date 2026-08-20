import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer, isWebGLAvailable } from "./webgl.js";

// Without a DOM (as here, and as on a GPU-less or WebGL-blocked browser) the
// probe reports false rather than throwing.
test("reports WebGL unavailable when there is no context", () => {
  assert.equal(isWebGLAvailable(), false);
});

// three.js throws from the renderer constructor on a failed context; the helper
// swallows it and hands back null so the caller can fall back.
test("returns null instead of throwing when a renderer can't be built", () => {
  assert.equal(createRenderer({ antialias: true }), null);
});
