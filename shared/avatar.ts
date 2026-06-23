/**
 * A trogg's avatar colour (GDD "Avatars and equipment"; programmer pixel art per
 * pillar 5). A trogg renders tinted by a colour from a fixed palette: the one it
 * chose (the `recolor` reducer stores its palette index on the row), or — until it
 * picks one — a stable default derived from its durable id, so an unchosen trogg
 * is the same colour for everyone, every session. The default is recomputed from
 * the id like a level is from XP, never stored.
 */

/** Distinct, readable tints against the world's dark ground — the recolour palette. */
export const TROGG_COLORS = [
  0xff8c2e, 0x6fdc9c, 0x4ea3ff, 0xffd34e, 0xff6b6b, 0xb388ff,
  0xff8cc6, 0x5ad1c8, 0xc0e85a, 0xe89c5a, 0x9ad0ff, 0xf45ad1,
] as const;

/** The stored value of a trogg that hasn't chosen a colour: fall back to the id-derived default. */
export const COLOR_UNSET = -1;

/** Whether `index` is a selectable palette entry (so a chosen colour the client can offer). */
export function isColorIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TROGG_COLORS.length;
}

/** A trogg's stable default colour, picked from the palette by hashing its id. */
export function troggColor(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return TROGG_COLORS[hash % TROGG_COLORS.length]!;
}

/** A trogg's display colour: its chosen palette entry, else the id-derived default. */
export function troggColorFor(colorIndex: number, userId: string): number {
  return isColorIndex(colorIndex) ? TROGG_COLORS[colorIndex]! : troggColor(userId);
}
