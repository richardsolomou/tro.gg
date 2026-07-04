/**
 * A trogg's avatar appearance (GDD "Avatars and equipment"; programmer low-poly
 * 3D per pillar 5). Two independent axes: a body **style** (the model, picked
 * by `restyle`) and a **colour** tint over it (picked by `recolor`). Each is the
 * value it chose (a palette/style index stored on the row), or — until it picks —
 * a stable default derived from its durable id, so an unchosen trogg looks the same
 * to everyone, every session. Defaults are recomputed from the id like a level is
 * from XP, never stored. Hogs have no row of their own, so their style is derived
 * straight from their entity id, giving a zone a varied, stable crowd.
 */

import { COMMON_HOG_STYLES, HOG_STYLES, TROGG_STYLES, type HogStyle, type TroggStyle } from "./creatures";

/** The recolour palette: earthy hide tints applied as a multiply over the model's
 *  olive base, so a trogg always reads as a believable stone-and-moss creature —
 *  natural greens, greys, tans and clays, never neon. */
export const TROGG_COLORS = [
  0xe9e2c6, // bone / natural olive
  0xbad880, // moss green
  0x8fbf5e, // deep forest green
  0xc9cf86, // olive khaki
  0xc7c6bb, // stone grey
  0xa6b3ab, // slate
  0xddc28d, // sand tan
  0xc89a5c, // ochre
  0xc4845e, // clay red-brown
  0xa89a6a, // mud olive
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

/** A trogg's stable default colour *index*, derived by hashing its id. */
export function troggColorIndex(userId: string): number {
  return hashId(userId) % TROGG_COLORS.length;
}

/** A trogg's stable default colour, picked from the palette by hashing its id. */
export function troggColor(userId: string): number {
  return TROGG_COLORS[troggColorIndex(userId)]!;
}

/** A trogg's effective colour *index*: its chosen entry, else the id-derived default.
 *  Lets the UI highlight the swatch a trogg actually shows, chosen or not. */
export function troggColorIndexFor(colorIndex: number, userId: string): number {
  return isColorIndex(colorIndex) ? colorIndex : troggColorIndex(userId);
}

/** A trogg's display colour: its chosen palette entry, else the id-derived default. */
export function troggColorFor(colorIndex: number, userId: string): number {
  return TROGG_COLORS[troggColorIndexFor(colorIndex, userId)]!;
}

/** Whether `index` is a selectable trogg style (so a chosen style the client can offer). */
export function isTroggStyleIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TROGG_STYLES.length;
}

/** A trogg's stable default style *index*, derived by hashing its id. The id is
 *  bit-rotated first so style and colour don't move in lockstep off one hash. */
export function troggStyleIndex(userId: string): number {
  return ((hashId(userId) ^ 0x9e3779b9) >>> 0) % TROGG_STYLES.length;
}

/** A trogg's stable default style, picked from the list by hashing its id. */
export function troggStyle(userId: string): TroggStyle {
  return TROGG_STYLES[troggStyleIndex(userId)]!;
}

/** A trogg's effective style *index*: its chosen entry, else the id-derived default.
 *  Lets the UI highlight the style button a trogg actually shows, chosen or not. */
export function troggStyleIndexFor(styleIndex: number, userId: string): number {
  return isTroggStyleIndex(styleIndex) ? styleIndex : troggStyleIndex(userId);
}

/** A trogg's display style: its chosen entry, else the id-derived default. */
export function troggStyleFor(styleIndex: number, userId: string): TroggStyle {
  return TROGG_STYLES[troggStyleIndexFor(styleIndex, userId)]!;
}

/** A common Hog's style, derived from its entity id — the small roaming crowd varies
 *  over `COMMON_HOG_STYLES`. Big and easter-egg hogs carry an explicit style on their
 *  row instead, so they never come up here. */
export function hogStyleFor(hogId: string, storedStyle = ""): HogStyle {
  return isHogStyle(storedStyle) ? storedStyle : COMMON_HOG_STYLES[hashId(hogId) % COMMON_HOG_STYLES.length]!;
}

/** Whether `style` is one of the registered Hog skins. */
export function isHogStyle(style: string): style is HogStyle {
  return (HOG_STYLES as readonly string[]).includes(style);
}
