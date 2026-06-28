/**
 * Ghost art (cosmetic easter egg): a hog draped in a pale sheet — two ear bumps
 * poke up, two dark eye holes, a scalloped hem, two stubby feet (ref:
 * ghost.png). One frame, never tinted.
 *
 * Standalone Node (tsx) — not part of the client or the module bundle.
 */

import { disc, dot, rect, shaded } from "../pixel_paint.ts";
import { FEET_Y } from "./rig.ts";
import type { PixelSink } from "../../shared/sprites.ts";

export const GHOST = {
  sheet: 0xf6f4ec,
  sheetDk: 0xd4d4cd,
  out: 0x1c1c1c,
  eye: 0x161616,
  foot: 0x9c6f3f,
  footDk: 0x6f4e2a,
  face: 0xf0dcab,
  faceDk: 0xcdac72,
} as const;

export function ghostDrawArt(p: PixelSink): void {
  const g = GHOST;
  shaded(p, 12, FEET_Y, 2.1, 1.9, g.foot, g.footDk);
  shaded(p, 19, FEET_Y, 2.1, 1.9, g.foot, g.footDk);
  // a sliver of quill at the hem
  disc(p, 15.5, 36, 7, 2, g.faceDk);
  // ear bumps poking through
  disc(p, 9, 11, 2.6, 3, g.face); disc(p, 22, 11, 2.6, 3, g.face);
  disc(p, 9, 11.6, 1.3, 1.5, g.faceDk); disc(p, 22, 11.6, 1.3, 1.5, g.faceDk);
  // draped body + domed head
  shaded(p, 15.5, 26 + 0, 11.6, 11.4, g.sheet, g.sheetDk);
  disc(p, 15.5, 16, 9.4, 7.6, g.sheet);
  // face windows + eyes
  disc(p, 12, 20, 3, 4.2, g.face); disc(p, 19, 20, 3, 4.2, g.face);
  rect(p, 11, 18, 2, 3, g.eye); dot(p, 11, 18, 0xffffff);
  rect(p, 18, 18, 2, 3, g.eye); dot(p, 18, 18, 0xffffff);
  dot(p, 15.5, 23, g.faceDk);
  // side fold shadows
  disc(p, 7, 30, 2.4, 6, g.sheetDk); disc(p, 24, 30, 2.4, 6, g.sheetDk);
  // scalloped hem
  for (let x = 6; x <= 25; x += 4) { disc(p, x, 36, 1.9, 1.5, g.sheet); dot(p, x + 2, 38, g.sheetDk); }
}
