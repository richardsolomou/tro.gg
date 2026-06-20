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

/** M0 ships a single shared zone. (working slug, initial dims) */
export const STARTING_ZONE = {
  slug: "hog-town",
  name: "Hog Town",
  width: 24,
  height: 16,
} as const;
