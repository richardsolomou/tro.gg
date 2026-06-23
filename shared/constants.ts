/**
 * Tuning values from the GDD. Those marked (initial) are expected to move to
 * feature flags — read them through here, never hardcode beliefs about them
 * elsewhere. See docs/gdd.md.
 */

/** Movement speed shared by click-to-move and WASD. (initial) */
export const MOVE_SPEED_TILES_PER_SEC = 4;

/** Chat. (initial) */
export const CHAT_MAX_CHARS = 200;
export const CHAT_BUBBLE_MS = 5_000;
export const CHAT_RATE_LIMIT_MS = 1_000;
/** Recent messages kept in zone state for the side-panel history. (initial) */
export const CHAT_HISTORY_MAX = 50;

/**
 * A zone: one contiguous area of the world — the unit of subscription,
 * rendering, and chat (GDD "Zones"). Definitions are static design data, like
 * the item and node registries, so they live in code; the GDD data model lists
 * a `zones` table, deferred until tilemaps need editable storage. width/height
 * are in tiles. (initial dims)
 */
export interface Zone {
  slug: string;
  name: string;
  width: number;
  height: number;
}

/**
 * Every zone in the world, keyed by slug. M0 ships one shared zone; later zones
 * are added here. The starting cave and hub gate land with M1.
 */
export const ZONES: Record<string, Zone> = {
  "hog-town": { slug: "hog-town", name: "Hog Town", width: 24, height: 16 },
};

/** Where a fresh trogg spawns, and the default room the client joins. */
export const STARTING_ZONE_SLUG = "hog-town";

/** Look up a zone definition, or undefined if the slug is unknown. */
export function getZone(slug: string): Zone | undefined {
  return ZONES[slug];
}
