/**
 * Placeholder avatar identity until layered sprites land (GDD "Avatars and
 * equipment"; programmer pixel art per pillar 5). A trogg renders as a solid
 * marker tinted by a stable colour derived from its durable id, so the same
 * trogg is the same colour for everyone, every session. Derived, never stored —
 * recomputed from the id like a level is from XP.
 */

/** Distinct, readable tints against the world's dark ground. */
export const TROGG_COLORS = [
  0xff8c2e, 0x6fdc9c, 0x4ea3ff, 0xffd34e, 0xff6b6b, 0xb388ff,
  0xff8cc6, 0x5ad1c8, 0xc0e85a, 0xe89c5a, 0x9ad0ff, 0xf45ad1,
] as const;

/** A trogg's stable marker colour, picked from the palette by hashing its id. */
export function troggColor(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return TROGG_COLORS[hash % TROGG_COLORS.length]!;
}
