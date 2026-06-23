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
 * Identity & accounts (GDD "Identity"). Guests are anonymous SpacetimeDB
 * identities; signing in upgrades a guest to an account whose identity SpacetimeDB
 * derives from a SpacetimeAuth OIDC token's `iss`+`sub`. The module trusts only
 * this issuer as an account provider (invariant 3 — never client-asserted).
 */
export const SPACETIMEAUTH_ISSUER = "https://auth.spacetimedb.com/oidc";

/** How long a claim nonce stays redeemable before the upgrade must be retried. (initial) */
export const CLAIM_CODE_TTL_MS = 10 * 60 * 1000;

/** Player name rules (GDD "Identity"): 3–20 chars, alphanumeric + hyphen. Uniqueness is enforced server-side. */
export const NAME_MIN_CHARS = 3;
export const NAME_MAX_CHARS = 20;
const NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** Whether `name` satisfies the GDD length + character rules (uniqueness is checked server-side). */
export function isValidName(name: string): boolean {
  return name.length >= NAME_MIN_CHARS && name.length <= NAME_MAX_CHARS && NAME_PATTERN.test(name);
}

/**
 * Whether `name` is an auto-generated guest name (`trogg-` + 4 hex of the
 * identity; see the module's `clientConnected`). Used when claiming: a guest's
 * chosen name carries onto the account, but a generated one never overwrites a
 * name the account already chose.
 */
export function isGeneratedName(name: string): boolean {
  return /^trogg-[0-9a-f]{4}$/.test(name);
}

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
