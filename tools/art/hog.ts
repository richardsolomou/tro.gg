/**
 * Hog art: a round cartoon hedgehog — a cream face and belly, two rounded ears,
 * big shiny eyes, a small nose, and a spiky quill mantle (refs:
 * surprised/blushing.png). The common styles `classic`/`snow`/`ember` share this
 * body; the big buff hog reuses `quillSpikes` for its mane.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, rect, shaded } from "../pixel_paint.ts";
import { bodyBob, drawArm, eye, feet, FEET_Y, type View } from "./rig.ts";
import { jointAt, skeletonFor, type JointName } from "../../shared/rig.ts";
import type { Facing, FrameName, PixelSink } from "../../shared/sprites.ts";

export interface HogSkin {
  out: number;
  quill: number;
  quillDk: number;
  face: number;
  faceDk: number;
  nose: number;
  eye: number;
  glint: number;
  limb: number;
}

export const HOG_SKINS: Record<string, HogSkin> = {
  classic: { out: 0x241a0e, quill: 0x7c5c37, quillDk: 0x503b22, face: 0xf0dcab, faceDk: 0xcdac72, nose: 0x3a2415, eye: 0x140d07, glint: 0xffffff, limb: 0x9c6f3f },
  snow: { out: 0x2b2a2e, quill: 0xb9bac1, quillDk: 0x83848d, face: 0xf3eee4, faceDk: 0xcfc4b2, nose: 0x564749, eye: 0x201a1a, glint: 0xffffff, limb: 0xada99f },
  ember: { out: 0x2a1810, quill: 0xb35a2c, quillDk: 0x7a3a18, face: 0xf0d6a4, faceDk: 0xcea06a, nose: 0x3a1c0e, eye: 0x1c100a, glint: 0xffffff, limb: 0xa9663a },
};

/** Spiky bumps around a dome's upper rim — outlined later, they read as quills. */
export function quillSpikes(p: PixelSink, cx: number, cy: number, rx: number, ry: number, colour: number): void {
  const dirs: [number, number][] = [
    [-0.96, -0.28], [-0.78, -0.66], [-0.45, -0.92], [-0.05, -1.02], [0.38, -0.95], [0.72, -0.72], [0.94, -0.32],
    [-1.0, 0.15], [1.0, 0.15],
  ];
  for (const [nx, ny] of dirs) disc(p, cx + nx * rx, cy + ny * ry, 2.1, 2.1, colour);
}

function hogEar(p: PixelSink, x: number, y: number, h: HogSkin): void {
  disc(p, x, y, 2.4, 2.4, h.face);
  disc(p, x, y + 0.4, 1.2, 1.2, h.faceDk);
}

/** A rounded paw at the hand joint — the cute cap on the end of a little hog arm. */
function hogPaw(p: PixelSink, x: number, y: number, h: HogSkin): void {
  shaded(p, x, y, 1.8, 1.9, h.face, h.faceDk);
}

/** One hog arm drawn from the shared rig: a short cream capsule shoulder→hand plus a paw, so it
 *  swings with the gait off the same hand joint a held item rides (no baked `armSwing` offset). */
function hogArmRig(p: PixelSink, facing: Facing, frame: FrameName, slot: "main" | "off", h: HogSkin): void {
  const sh = jointAt("hog", facing, frame, slot === "main" ? "mainShoulder" : "offShoulder");
  const hd = jointAt("hog", facing, frame, slot === "main" ? "mainHand" : "offHand");
  drawArm(p, sh.x, sh.y, hd.x, hd.y, 2.4, h.face, h.faceDk);
  hogPaw(p, hd.x, hd.y, h);
}

/** A cute front face: shiny eyes, a soft muzzle, a small nose. */
function hogFaceFront(p: PixelSink, h: HogSkin, cy: number): void {
  eye(p, 10, cy - 1, h.eye, h.glint);
  eye(p, 20, cy - 1, h.eye, h.glint);
  // muzzle + nose
  disc(p, 15.5, cy + 3, 2.6, 2, h.faceDk);
  rect(p, 14, cy + 2, 3, 2, h.nose);
  dot(p, 15.5, cy + 4, h.out);
}

/** The hog minus its in-front main (near) arm — the body, head, off arm, and (facing up, where
 *  the main arm sits behind) the main arm too. `hogDraw` adds the in-front main arm on top; the
 *  generator paints body and arm apart so the near arm can ride over a held item with one outline. */
export function hogBody(p: PixelSink, view: View, frame: FrameName, h: HogSkin): void {
  const facing: Facing = view === "side" ? "right" : view;
  const b = bodyBob(frame);
  const behind = skeletonFor("hog", facing).behind;
  feet(p, frame, h.limb, h.out, FEET_Y, 12, 19);

  if (view === "up") {
    quillSpikes(p, 15.5, 24 + b, 13, 13.5, h.quill);
    shaded(p, 15.5, 24 + b, 13, 13.5, h.quill, h.quillDk);
    hogEar(p, 9, 13 + b, h); hogEar(p, 22, 13 + b, h);
    disc(p, 15.5, 30 + b, 7, 5, h.quillDk);
    hogArmRig(p, facing, frame, "off", h);
    hogArmRig(p, facing, frame, "main", h); // behind the body when facing away, so part of the body
    return;
  }

  if (view === "side") {
    quillSpikes(p, 11, 24 + b, 9.5, 12, h.quill);
    shaded(p, 11, 24 + b, 9.5, 12, h.quill, h.quillDk);
    shaded(p, 18, 31 + b, 8, 6.6, h.face, h.faceDk);
    hogEar(p, 20, 16 + b, h);
    shaded(p, 22, 22 + b, 6, 5.4, h.face, h.faceDk);
    disc(p, 27, 24 + b, 2.4, 2, h.faceDk);
    rect(p, 28, 23 + b, 2, 2, h.nose);
    eye(p, 22, 20 + b, h.eye, h.glint);
    return; // the near (main) arm is drawn on top by hogDraw / as the overlay
  }

  // front: quill mantle, cream body and head, ears, face, the off arm (main rides on top)
  quillSpikes(p, 15.5, 22 + b, 13, 13.5, h.quill);
  shaded(p, 15.5, 22 + b, 13, 13.5, h.quill, h.quillDk);
  hogEar(p, 9, 11 + b, h); hogEar(p, 22, 11 + b, h);
  shaded(p, 15.5, 32 + b, 9.2, 7.2, h.face, h.faceDk);
  hogArmRig(p, facing, frame, "off", h);
  if (behind) hogArmRig(p, facing, frame, "main", h);
  shaded(p, 15.5, 19 + b, 8, 6.6, h.face, h.faceDk);
  hogFaceFront(p, h, 18 + b);
}

/** The in-front main (near) hog arm, for the facings where it sits ahead of the body. Empty when
 *  it tucks behind (facing up). Drawn last by `hogDraw`, emitted as the over-item overlay. */
export function hogMainArm(p: PixelSink, view: View, frame: FrameName, h: HogSkin): void {
  const facing: Facing = view === "side" ? "right" : view;
  if (skeletonFor("hog", facing).behind) return;
  hogArmRig(p, facing, frame, "main", h);
}

export function hogDraw(p: PixelSink, view: View, frame: FrameName, h: HogSkin): void {
  hogBody(p, view, frame, h);
  hogMainArm(p, view, frame, h);
}
