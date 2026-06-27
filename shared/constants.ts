/**
 * Tuning values from the GDD. Those marked (initial) are starting values; keep
 * them centralized here and make them remotely configurable only when runtime
 * tuning or experiments are useful. See docs/gdd.md.
 */

/** Movement speed shared by click-to-move and WASD. (initial) */
export const MOVE_SPEED_TILES_PER_SEC = 4;

/**
 * Running speed (GDD "Movement"): holding shift while moving runs instead of
 * walks. It rides the synced motion intent (`player.running`), so every client
 * derives the same faster position with `projectMotion` — no per-frame sync and
 * no determinism mismatch (invariants 2 & 3). Optionally gated by the `running` flag. (initial)
 */
export const RUN_SPEED_TILES_PER_SEC = 7;

/**
 * Roaming Hogs (GDD "Hogs"). Ambient hedgehog NPCs amble tile by tile: a scheduled
 * reducer re-bases every Hog once per tile (`HOG_STEP_INTERVAL_MS`, the time to cross
 * one tile at walk speed), so a Hog only ever commits to one tile at a time and stops
 * flush against whatever's solid — walls, boulders, troggs, and other Hogs. Each step a
 * moving Hog keeps its heading unless that tile is blocked or a `HOG_TURN_CHANCE` roll
 * turns it; a fresh heading lands on idle with `HOG_IDLE_CHANCE` so they pause rather
 * than march nonstop. They ride the same intent-based motion as troggs, so there's no
 * per-frame sync. Stepping one tile at a time (rather than routing a multi-tile path)
 * keeps a Hog's banked travel to at most one tile, so a Hog freed from a block never
 * lurches more than a tile. (initial)
 */
export const HOG_STEP_INTERVAL_MS = 1_000 / MOVE_SPEED_TILES_PER_SEC;
export const HOG_TURN_CHANCE = 0.15;
export const HOG_IDLE_CHANCE = 0.25;

/**
 * Per-zone entity ceilings (GDD "Data model"). `/spawn` and carried-object drops insert
 * boulders/Hogs into the shared zone, so the server refuses once a zone is at its cap —
 * a scripted client can't flood a zone with entities and inflate every `wanderHogs` tick.
 * Enforced server-side (invariant 3); the client feature flags only gate the UI, not the
 * reducer. Far above the registry seeds (2 boulders, 6 Hogs) — purely a DoS ceiling. (initial)
 */
export const MAX_HOGS_PER_ZONE = 64;
export const MAX_BOULDERS_PER_ZONE = 64;

/** Chat. (initial) */
export const CHAT_MAX_CHARS = 200;
export const CHAT_BUBBLE_MS = 5_000;
export const CHAT_RATE_LIMIT_MS = 1_000;
/** Recent messages kept in zone state for the side-panel history. (initial) */
export const CHAT_HISTORY_MAX = 50;

/**
 * Tilemap glyphs (GDD "Zones"). Each character in a zone's `tiles` rows is one
 * tile. `WALL_TILE` (`#`) is the only unwalkable glyph — `isWalkable` treats it,
 * and only it, as solid; every other glyph is walkable floor. The non-wall glyphs
 * are cosmetic floor variants (gravel, moss, shallow water, glowmoss) so a zone
 * reads as varied terrain rather than one flat stone fill — they change how a tile
 * is drawn (`src/game/terrain.ts`), never how it collides. Water is a shallow puddle
 * the trogg wades through, so it stays walkable; an impassable pool would be a
 * `#`-class glyph instead. `assertZones` rejects any glyph not listed here.
 */
export const WALL_TILE = "#";
export const FLOOR_TILE = ".";
export const GRAVEL_TILE = ",";
export const MOSS_TILE = '"';
export const WATER_TILE = "~";
export const GLOWMOSS_TILE = "*";

/** Every recognised tilemap glyph. A character outside this set is a typo, not a tile. */
export const TILE_GLYPHS: ReadonlySet<string> = new Set([
  WALL_TILE,
  FLOOR_TILE,
  GRAVEL_TILE,
  MOSS_TILE,
  WATER_TILE,
  GLOWMOSS_TILE,
]);

/** An integer tile coordinate within a zone. */
export interface Coord {
  x: number;
  y: number;
}

/** Item ids are canonical across inventory rows, equipment slots, and UI labels. */
export const ITEM_IDS = ["stone", "pickaxe", "shovel", "sword"] as const;
export type ItemId = (typeof ITEM_IDS)[number];

export type EquipmentSlot = "mainHand";

export interface ItemDef {
  id: ItemId;
  name: string;
  stackable: boolean;
  blurb: string;
  slot?: EquipmentSlot;
  sprite?: "pickaxe" | "shovel" | "sword";
}

/**
 * Static item registry (GDD "Inventory"). Inventory rows store only item id and
 * quantity; holdable items point at their equipment slot and sprite.
 */
export const ITEMS: Record<ItemId, ItemDef> = {
  stone: {
    id: "stone",
    name: "Stone",
    stackable: true,
    blurb: "A useful chunk of cave rock.",
  },
  pickaxe: {
    id: "pickaxe",
    name: "Pickaxe",
    stackable: false,
    blurb: "Equipped in the main hand. Use it to mine boulders into stone.",
    slot: "mainHand",
    sprite: "pickaxe",
  },
  shovel: {
    id: "shovel",
    name: "Shovel",
    stackable: false,
    blurb: "Equipped in the main hand. It is ready for digging once soil rules exist.",
    slot: "mainHand",
    sprite: "shovel",
  },
  sword: {
    id: "sword",
    name: "Sword",
    stackable: false,
    blurb: "Equipped in the main hand. It swings, but combat waits for PvE events.",
    slot: "mainHand",
    sprite: "sword",
  },
};

export function isItemId(item: string): item is ItemId {
  return (ITEM_IDS as readonly string[]).includes(item);
}

export function isEquippableItem(item: string): item is ItemId {
  return isItemId(item) && ITEMS[item].slot === "mainHand";
}

export function isStackableItem(item: string): item is ItemId {
  return isItemId(item) && ITEMS[item].stackable;
}

export interface GroundItemSeed extends Coord {
  item: ItemId;
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
 * `tiles` is the per-tile tilemap (GDD "Zones"): one string per row, each
 * character a tile glyph (see `TILE_GLYPHS`). `WALL_TILE` (`#`) is unwalkable;
 * every other glyph is walkable floor, with the non-`.` glyphs (gravel, moss,
 * shallow water, glowmoss) selecting a cosmetic floor variant so a zone looks
 * varied rather than uniform. Movement is confined to walkable tiles, both client
 * and server reading it through `isWalkable` (invariant 3), which keys only off
 * `#` — so decorative glyphs never change collision. The grid must be
 * `width × height` and use only known glyphs; `assertZones` checks both.
 *
 * `boulders` lists the starting tiles of the zone's pushable boulders — dynamic
 * obstacles seeded into the `boulder` table on first connect, then mutated only
 * by the `push` reducer. They must start on walkable floor; `assertZones` checks
 * that too.
 *
 * `hogs` lists the starting tiles of the zone's ambient roaming Hogs (GDD
 * "Hogs"), seeded into the `hog` table on first connect and then moved only by the
 * scheduled `wanderHogs` reducer. They must start on walkable floor too.
 *
 * `items` lists starter pickup items. A pickup has a registry item id and a tile;
 * pressing `E` while facing it moves the item into inventory and removes the row.
 */
export interface Zone {
  slug: string;
  name: string;
  width: number;
  height: number;
  tiles: readonly string[];
  boulders: readonly Coord[];
  hogs: readonly Coord[];
  items: readonly GroundItemSeed[];
}

/**
 * Every zone in the world, keyed by slug. The current world has one shared zone;
 * later zones, starting areas, and gates are added here when they serve the game.
 *
 * `hog-town` is a 24×16 cave: a one-tile rock wall around the rim with two rock
 * pillars inside, so the playable floor is a real non-rectangular shape. The floor
 * is dressed with cosmetic tile variants (see `TILE_GLYPHS`) — gravel scree (`,`)
 * spilling around the rock pillars, moss (`"`) in the damp corners, a shallow
 * water puddle (`~`) in the low corner, and glowmoss (`*`) accents scattered
 * about — so the cave reads as varied terrain. They are all walkable; only `#`
 * blocks. Edit `tiles` to carve new layouts — walkability and rendering both read
 * from it. Two boulders flank the spawn (zone centre, 12×8) so a fresh trogg can
 * push one left and one right straight away. A handful of Hogs are scattered
 * around the floor and roam on their own (GDD "Hogs").
 */
export const ZONES: Record<string, Zone> = {
  "hog-town": {
    slug: "hog-town",
    name: "Hog Town",
    width: 24,
    height: 16,
    tiles: [
      "########################",
      "#\"\"....................#",
      "#\"\"......*.............#",
      "#\"..,,,,.............\".#",
      "#...,##,.............\"\"#",
      "#...,##,...\"\".........\"#",
      "#...,,,,............*..#",
      "#......................#",
      "#......................#",
      "#.......*......,,,,....#",
      "#..............,##,....#",
      "#\"\".......,,...,##,....#",
      "#.~~\"........*.,,,,....#",
      "#~~~~\".........*...*...#",
      "#~~~~\".................#",
      "########################",
    ],
    boulders: [
      { x: 10, y: 8 },
      { x: 14, y: 8 },
    ],
    hogs: [
      { x: 3, y: 3 },
      { x: 20, y: 3 },
      { x: 12, y: 2 },
      { x: 3, y: 12 },
      { x: 20, y: 12 },
      { x: 8, y: 13 },
    ],
    items: [
      { item: "pickaxe", x: 11, y: 7 },
      { item: "shovel", x: 12, y: 7 },
      { item: "sword", x: 13, y: 7 },
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
      for (const glyph of row) {
        if (!TILE_GLYPHS.has(glyph)) {
          throw new Error(`zone ${zone.slug}: row ${y} has unknown tile glyph ${JSON.stringify(glyph)}`);
        }
      }
    }
    for (const b of zone.boulders) {
      if (!isWalkable(zone, b.x, b.y)) {
        throw new Error(`zone ${zone.slug}: boulder at (${b.x}, ${b.y}) is not on walkable floor`);
      }
    }
    for (const h of zone.hogs) {
      if (!isWalkable(zone, h.x, h.y)) {
        throw new Error(`zone ${zone.slug}: hog at (${h.x}, ${h.y}) is not on walkable floor`);
      }
    }
    for (const item of zone.items) {
      if (!isItemId(item.item)) {
        throw new Error(`zone ${zone.slug}: ground item ${JSON.stringify(item.item)} is not registered`);
      }
      if (!isWalkable(zone, item.x, item.y)) {
        throw new Error(`zone ${zone.slug}: ground item ${item.item} at (${item.x}, ${item.y}) is not on walkable floor`);
      }
    }
  }
}
