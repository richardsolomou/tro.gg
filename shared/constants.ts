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

/** Tilemap character for an unwalkable tile (wall, rock, void). Anything else is floor. */
export const WALL_TILE = "#";

/** An integer tile coordinate within a zone. */
export interface Coord {
  x: number;
  y: number;
}

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
 *
 * `tiles` is the per-tile walkability tilemap (GDD "Zones"): one string per row,
 * each character a tile — `WALL_TILE` (`#`) is unwalkable, everything else is
 * floor. Movement is confined to walkable tiles, both client and server reading
 * it through `isWalkable` (invariant 3). Scenery beyond walkability is deferred.
 * The grid must be `width × height`; `assertZones` checks it.
 *
 * `boulders` lists the starting tiles of the zone's pushable boulders — dynamic
 * obstacles seeded into the `boulder` table on first connect, then mutated only
 * by the `push` reducer. They must start on walkable floor; `assertZones` checks
 * that too.
 */
export interface Zone {
  slug: string;
  name: string;
  width: number;
  height: number;
  tiles: readonly string[];
  boulders: readonly Coord[];
}

/**
 * Every zone in the world, keyed by slug. M0 ships one shared zone; later zones
 * are added here. The starting cave and hub gate land with M1.
 *
 * `hog-town` is a 24×16 cave: a one-tile rock wall around the rim with two rock
 * pillars inside, so the playable floor is a real non-rectangular shape. Edit
 * `tiles` to carve new layouts — walkability and rendering both read from it.
 * Two boulders flank the spawn (zone centre, 12×8) so a fresh trogg can push one
 * left and one right straight away.
 */
export const ZONES: Record<string, Zone> = {
  "hog-town": {
    slug: "hog-town",
    name: "Hog Town",
    width: 24,
    height: 16,
    tiles: [
      "########################",
      "#......................#",
      "#......................#",
      "#......................#",
      "#....##................#",
      "#....##................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#......................#",
      "#................##....#",
      "#................##....#",
      "#......................#",
      "#......................#",
      "#......................#",
      "########################",
    ],
    boulders: [
      { x: 10, y: 8 },
      { x: 14, y: 8 },
    ],
  },
};

/** Where a fresh trogg spawns, and the default room the client joins. */
export const STARTING_ZONE_SLUG = "hog-town";

/** Look up a zone definition, or undefined if the slug is unknown. */
export function getZone(slug: string): Zone | undefined {
  return ZONES[slug];
}

/**
 * Is the tile at (tileX, tileY) walkable in this zone? Out-of-bounds is
 * unwalkable, so movement clamps at the zone edge the same way it clamps at a
 * wall. Coordinates are integer tile indices.
 */
export function isWalkable(zone: Zone, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileY >= zone.tiles.length) return false;
  const row = zone.tiles[tileY]!;
  if (tileX >= row.length) return false;
  return row[tileX] !== WALL_TILE;
}

/**
 * Guard that every zone's tilemap matches its declared dimensions — a typo in a
 * row length would silently break collision, so fail loudly instead. Called by a
 * unit test; cheap enough to also run at module load if ever needed.
 */
export function assertZones(): void {
  for (const zone of Object.values(ZONES)) {
    if (zone.tiles.length !== zone.height) {
      throw new Error(`zone ${zone.slug}: ${zone.tiles.length} rows, expected height ${zone.height}`);
    }
    for (const [y, row] of zone.tiles.entries()) {
      if (row.length !== zone.width) {
        throw new Error(`zone ${zone.slug}: row ${y} is ${row.length} wide, expected width ${zone.width}`);
      }
    }
    for (const b of zone.boulders) {
      if (!isWalkable(zone, b.x, b.y)) {
        throw new Error(`zone ${zone.slug}: boulder at (${b.x}, ${b.y}) is not on walkable floor`);
      }
    }
  }
}
