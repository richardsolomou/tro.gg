/**
 * Buff hog art: a swole hedgehog mid double-biceps flex — tan muscle, ab lines,
 * a quill mane, a tiny smug face (ref: 1.png). A big 2×2 showpiece authored at
 * the shared frame size and rendered at double size.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, line, rect, shaded } from "../pixel_paint.ts";
import { bodyBob, feet, FEET_Y, type View } from "./rig.ts";
import { quillSpikes } from "./hog.ts";
import type { FrameName, PixelSink } from "../../shared/sprites.ts";

export const BUFF = {
  out: 0x241a0e,
  skin: 0xd2a96f,
  skinDk: 0x9c7438,
  face: 0xf0dcab,
  quill: 0x7c5c37,
  quillDk: 0x503b22,
  nose: 0x3a2415,
  eye: 0x1c140c,
} as const;

export function buffDraw(p: PixelSink, view: View, frame: FrameName): void {
  const c = BUFF;
  const b = bodyBob(frame);
  feet(p, frame, c.skin, c.out, FEET_Y, 11, 20);
  shaded(p, 12, 35 + b, 3.4, 4.4, c.skin, c.skinDk);
  shaded(p, 19, 35 + b, 3.4, 4.4, c.skin, c.skinDk);

  if (view === "up") {
    disc(p, 15.5, 14 + b, 6, 4.6, c.quill);
    shaded(p, 15.5, 26 + b, 11, 9, c.skin, c.skinDk);
    rect(p, 14, 18 + b, 3, 12, c.skinDk);
    shaded(p, 4, 18 + b, 3.4, 6, c.skin, c.skinDk);
    shaded(p, 27, 18 + b, 3.4, 6, c.skin, c.skinDk);
    return;
  }

  const side = view === "side";
  shaded(p, 15.5, 27 + b, side ? 9.6 : 11.2, 8.4, c.skin, c.skinDk);
  // pecs + ab lines
  disc(p, 11, 25 + b, 3.2, 2.6, c.skin); disc(p, 20, 25 + b, 3.2, 2.6, c.skin);
  line(p, 15.5, 25 + b, 15.5, 34 + b, c.skinDk);
  line(p, 11, 29 + b, 20, 29 + b, c.skinDk);
  line(p, 11, 32 + b, 20, 32 + b, c.skinDk);
  // flexed arms framing the head: shoulder, peaked bicep, raised fist
  for (const s of [-1, 1] as const) {
    const sx = 15.5 + s * 8.5;
    shaded(p, sx, 23 + b, 3.6, 4, c.skin, c.skinDk);
    shaded(p, sx + s * 0.5, 17 + b, 3.4, 3.4, c.skin, c.skinDk);
    disc(p, sx + s * 1.5, 12 + b, 2.4, 2.4, c.skin);
  }
  // quill mane high on the crown
  disc(p, 15.5, 11 + b, 4.6, 3.4, c.quill);
  quillSpikes(p, 15.5, 11.5 + b, 4.6, 3.2, c.quill);
  // smug face, clear between the arms
  shaded(p, 15.5, 16.5 + b, 4.6, 3.8, c.face, c.skinDk);
  rect(p, 13, 15.5 + b, 2, 2, c.eye); rect(p, 17, 15.5 + b, 2, 2, c.eye);
  dot(p, 13, 15.5 + b, 0xffffff); dot(p, 17, 15.5 + b, 0xffffff);
  dot(p, 15.5, 17.5 + b, c.nose);
  line(p, 13.6, 19 + b, 17.4, 19 + b, c.out);
}
