/**
 * A trogg's avatar appearance (GDD "Avatars and equipment"; programmer pixel art
 * per pillar 5). Two independent axes: a body **style** (the sprite shape, picked
 * by `restyle`) and a **colour** tint over it (picked by `recolor`). Each is the
 * value it chose (a palette/style index stored on the row), or — until it picks —
 * a stable default derived from its durable id, so an unchosen trogg looks the same
 * to everyone, every session. Defaults are recomputed from the id like a level is
 * from XP, never stored. Hogs have no row of their own, so their style is derived
 * straight from their entity id, giving a zone a varied, stable crowd.
 */

import { HOG_STYLES, TROGG_STYLES, type HogStyle, type TroggStyle } from "./sprites";

/** Distinct, readable tints against the world's dark ground — the recolour palette. */
export const TROGG_COLORS = [
  0xff8c2e, 0x6fdc9c, 0x4ea3ff, 0xffd34e, 0xff6b6b, 0xb388ff,
  0xff8cc6, 0x5ad1c8, 0xc0e85a, 0xe89c5a, 0x9ad0ff, 0xf45ad1,
] as const;

/** The stored value of a trogg that hasn't chosen a colour / style: fall back to the id-derived default. */
export const COLOR_UNSET = -1;
export const STYLE_UNSET = -1;

/** FNV-ish stable string hash → unsigned 32-bit, for id-derived defaults. */
function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash;
}

/** Whether `index` is a selectable palette entry (so a chosen colour the client can offer). */
export function isColorIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TROGG_COLORS.length;
}

/** A trogg's stable default colour, picked from the palette by hashing its id. */
export function troggColor(userId: string): number {
  return TROGG_COLORS[hashId(userId) % TROGG_COLORS.length]!;
}

/** A trogg's display colour: its chosen palette entry, else the id-derived default. */
export function troggColorFor(colorIndex: number, userId: string): number {
  return isColorIndex(colorIndex) ? TROGG_COLORS[colorIndex]! : troggColor(userId);
}

/** Whether `index` is a selectable trogg style (so a chosen style the client can offer). */
export function isTroggStyleIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TROGG_STYLES.length;
}

/** A trogg's stable default style, picked from the list by hashing its id. The id
 *  is bit-rotated first so style and colour don't move in lockstep off one hash. */
export function troggStyle(userId: string): TroggStyle {
  const h = (hashId(userId) ^ 0x9e3779b9) >>> 0;
  return TROGG_STYLES[h % TROGG_STYLES.length]!;
}

/** A trogg's display style: its chosen entry, else the id-derived default. */
export function troggStyleFor(styleIndex: number, userId: string): TroggStyle {
  return isTroggStyleIndex(styleIndex) ? TROGG_STYLES[styleIndex]! : troggStyle(userId);
}

/** A Hog's style, derived from its entity id — Hogs don't choose, they just vary. */
export function hogStyleFor(hogId: string): HogStyle {
  return HOG_STYLES[hashId(hogId) % HOG_STYLES.length]!;
}
