/**
 * Hog art: a round cartoon hedgehog — a cream face and belly, two rounded ears,
 * big shiny eyes, a small nose, and a spiky quill mantle (refs:
 * surprised/blushing.png). The common styles `classic`/`snow`/`ember` share this
 * body; the big buff hog reuses `quillSpikes` for its mane.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, rect, shaded, translated } from "../pixel_paint.ts";
import { drawArm, eye, feet, FEET_Y, type View } from "./rig.ts";
import { bodyLean, jointAt, rootBob, skeletonFor, type JointName } from "../../shared/rig.ts";
import type { Facing, FrameName, PixelSink } from "../../shared/sprites.ts";

export interface HogSkin {
  out: number;
  quill: number;
  quillDk: number;
  face: number;
  faceHi: number;
  faceDk: number;
  nose: number;
  eye: number;
  glint: number;
  limb: number;
}

export const HOG_SKINS: Record<string, HogSkin> = {
  classic: { out: 0x1c1208, quill: 0x8a5a2e, quillDk: 0x4a2d14, face: 0xf8d88a, faceHi: 0xfff0bc, faceDk: 0xc6904a, nose: 0x2c1808, eye: 0x100804, glint: 0xffffff, limb: 0xa86a30 },
  snow: { out: 0x202024, quill: 0xc8cad0, quillDk: 0x777b88, face: 0xfff0d8, faceHi: 0xffffff, faceDk: 0xc8b898, nose: 0x504048, eye: 0x181014, glint: 0xffffff, limb: 0xb8b0a0 },
  ember: { out: 0x241008, quill: 0xc85828, quillDk: 0x743014, face: 0xf8d080, faceHi: 0xffecb0, faceDk: 0xc88842, nose: 0x301408, eye: 0x180804, glint: 0xffffff, limb: 0xb0602c },
};

/** Spiky bumps around a dome's upper rim — outlined later, they read as quills. */
export function quillSpikes(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number): void {
  const dirs: [number, number][] = [
    [-0.96, -0.28], [-0.78, -0.66], [-0.45, -0.92], [-0.05, -1.02], [0.38, -0.95], [0.72, -0.72], [0.94, -0.32],
    [-1.0, 0.15], [1.0, 0.15],
  ];
  for (const [nx, ny] of dirs) disc(p, cx + nx * rx, cy + ny * ry, 2.1, 2.1, colour);
}

/** A full ring of quills around a curled body — the ball form bristles in every direction, not
 *  just the upper-rim mantle of the standing hog. */
function ballSpikes(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number): void {
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    disc(p, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 2.1, 2.1, colour);
  }
}

/** A content closed eye: a small downward "‿" tuck, for the curled hog with its face buried. */
function closedEye(p: PixelSink, x: number, y: number, colour: number): void {
  dot(p, x - 1, y, colour);
  dot(p, x, y + 1, colour);
  dot(p, x + 1, y, colour);
}

function hogEar(p: PixelSink, x: number, y: number, h: HogSkin): void {
  disc(p, x, y, 2.4, 2.4, h.face);
  dot(p, x - 1, y - 1, h.faceHi);
  disc(p, x, y + 0.4, 1.2, 1.2, h.faceDk);
}

/** A rounded paw at the hand joint — the cute cap on the end of a little hog arm. */
function hogPaw(p: PixelSink, x: number, y: number, h: HogSkin): void {
  shaded(p, x, y, 1.8, 1.9, h.face, h.faceDk);
  dot(p, x - 1, y - 1, h.faceHi);
}

/** One hog arm drawn from the shared rig: a short cream capsule shoulder→hand plus a paw, so it
 *  swings with the gait off the same hand joint a held item rides (no baked `armSwing` offset). */
function hogArmRig(p: PixelSink, facing: Facing, frame: FrameName, slot: "main" | "off", h: HogSkin, handDy = 0): void {
  const sh = jointAt("hog", facing, frame, slot === "main" ? "mainShoulder" : "offShoulder");
  const hd = jointAt("hog", facing, frame, slot === "main" ? "mainHand" : "offHand");
  const hy = hd.y + handDy;
  drawArm(p, sh.x, sh.y, hd.x, hy, 2.4, h.face, h.faceDk);
  hogPaw(p, hd.x, hy, h);
}

/** A cute front face: shiny eyes, a soft muzzle, a small nose. */
function hogFaceFront(p: PixelSink, h: HogSkin, cy: number): void {
  eye(p, 10, cy - 1, h.eye, h.glint);
  eye(p, 20, cy - 1, h.eye, h.glint);
  rect(p, 12, cy - 4, 7, 1, h.faceHi);
  // muzzle + nose
  disc(p, 15.5, cy + 3, 2.6, 2, h.faceDk);
  rect(p, 13, cy + 2, 2, 1, h.faceHi);
  rect(p, 14, cy + 2, 3, 2, h.nose);
  dot(p, 15.5, cy + 4, h.out);
}

/** A few large highlight tiles, matching GSC's sparse interior detail. */
function hogGscHighlights(p: PixelSink, view: View, b: number, h: HogSkin): void {
  if (view === "side") {
    rect(p, 12, 18 + b, 4, 1, h.quillDk);
    rect(p, 18, 28 + b, 4, 1, h.faceHi);
    rect(p, 14, 33 + b, 3, 1, h.faceDk);
    return;
  }
  if (view === "up") {
    rect(p, 10, 20 + b, 5, 1, h.quill);
    rect(p, 17, 29 + b, 5, 1, h.quillDk);
    return;
  }
  rect(p, 10, 16 + b, 4, 1, h.faceHi);
  rect(p, 18, 24 + b, 5, 1, h.quillDk);
  rect(p, 12, 31 + b, 5, 1, h.faceHi);
}

/** The hog minus its in-front main (near) arm — the body, head, off arm, and (facing up, where
 *  the main arm sits behind) the main arm too. `hogDraw` adds the in-front main arm on top; the
 *  generator paints body and arm apart so the near arm can ride over a held item with one outline. */
export function hogBody(p: PixelSink, view: View, frame: FrameName, h: HogSkin): void {
  const facing: Facing = view === "side" ? "right" : view;
  const b = rootBob(frame); // the rig's bob, so the body dips exactly with the rig-driven arms
  const behind = skeletonFor("hog", facing).behind;
  feet(p, "hog", facing, frame, h.limb, h.out, FEET_Y, view === "side" ? 19 : 12, view === "side" ? 12 : 19);

  if (view === "up") {
    quillSpikes(p, 15.5, 24 + b, 13, 13.5, h.quill);
    shaded(p, 15.5, 24 + b, 13, 13.5, h.quill, h.quillDk);
    hogGscHighlights(p, view, b, h);
    hogEar(p, 9, 13 + b, h); hogEar(p, 22, 13 + b, h);
    disc(p, 15.5, 30 + b, 7, 5, h.quillDk);
    hogArmRig(p, facing, frame, "off", h);
    hogArmRig(p, facing, frame, "main", h); // behind the body when facing away, so part of the body
    return;
  }

  if (view === "side") {
    // the body group leans through a shifted sink, matching the rig's arm lean
    const q = translated(p, bodyLean("hog", facing, frame), 0);
    quillSpikes(q, 11, 24 + b, 9.5, 12, h.quill);
    shaded(q, 11, 24 + b, 9.5, 12, h.quill, h.quillDk);
    shaded(q, 18, 31 + b, 8, 6.6, h.face, h.faceDk);
    hogGscHighlights(q, view, b, h);
    hogEar(q, 20, 16 + b, h);
    shaded(q, 22, 22 + b, 6, 5.4, h.face, h.faceDk);
    disc(q, 27, 24 + b, 2.4, 2, h.faceDk);
    rect(q, 28, 23 + b, 2, 2, h.nose);
    eye(q, 22, 20 + b, h.eye, h.glint);
    return; // the near (main) arm is drawn on top by hogDraw / as the overlay
  }

  // front: quill mantle, cream body and head, ears, face, the off arm (main rides on top)
  quillSpikes(p, 15.5, 22 + b, 13, 13.5, h.quill);
  shaded(p, 15.5, 22 + b, 13, 13.5, h.quill, h.quillDk);
  hogGscHighlights(p, view, b, h);
  hogEar(p, 9, 11 + b, h); hogEar(p, 22, 11 + b, h);
  shaded(p, 15.5, 32 + b, 9.2, 7.2, h.face, h.faceDk);
  hogArmRig(p, facing, frame, "off", h);
  if (behind) hogArmRig(p, facing, frame, "main", h);
  shaded(p, 15.5, 19 + b, 8, 6.6, h.face, h.faceDk);
  hogFaceFront(p, h, 18 + b);
}

/** The in-front main (near) hog arm, for the facings where it sits ahead of the body. Empty when
 *  it tucks behind (facing up). Drawn last by `hogDraw`, emitted as the over-item overlay. */
export function hogMainArm(p: PixelSink, view: View, frame: FrameName, h: HogSkin, handDy = 0): void {
  const facing: Facing = view === "side" ? "right" : view;
  if (skeletonFor("hog", facing).behind) return;
  hogArmRig(p, facing, frame, "main", h, handDy);
}

export function hogDraw(p: PixelSink, view: View, frame: FrameName, h: HogSkin): void {
  hogBody(p, view, frame, h);
  hogMainArm(p, view, frame, h);
}

/** The defensive curl: the hog tucked into a spiky ball — quills bristling all the way round a
 *  round body, with a cream underbelly and a buried, content face (closed eyes, little nose) and
 *  tiny paws poking out at the front. One pose, facing-independent (a ball reads the same from
 *  any side), so it lives outside the per-facing frame grid (`HOG_BALL_ART`). */
export function hogBall(p: PixelSink, h: HogSkin): void {
  const cx = 15.5;
  const cy = 30;
  const rx = 12;
  const ry = 11.5;
  ballSpikes(p, cx, cy, rx + 1, ry + 1, h.quill);
  shaded(p, cx, cy, rx, ry, h.quill, h.quillDk);
  rect(p, cx - 6, cy - 7, 6, 1, h.quill);
  rect(p, cx + 2, cy + 1, 5, 1, h.quillDk);
  // cream face/belly tucked at the front-bottom, with the face buried in the curl
  shaded(p, cx, cy + 4, 8, 6, h.face, h.faceDk);
  rect(p, cx - 4, cy + 1, 5, 1, h.faceHi);
  closedEye(p, 12, cy + 2, h.out);
  closedEye(p, 19, cy + 2, h.out);
  disc(p, cx, cy + 6, 2.4, 1.8, h.faceDk);
  rect(p, 14, cy + 5, 3, 2, h.nose);
  dot(p, cx, cy + 7, h.out);
  // little paws poking out below the curl
  shaded(p, 10, cy + 9, 1.9, 1.7, h.face, h.faceDk);
  shaded(p, 21, cy + 9, 1.9, 1.7, h.face, h.faceDk);
}
