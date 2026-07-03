export * from "./glyphs";
import { SOLID_GLYPHS, TILE_GLYPHS, WATER_TILE } from "./glyphs";
import { setRegionRows, WORLD_H, WORLD_W } from "./worldgen";
import { WORLD_BIG_HOGS, WORLD_BOULDERS, WORLD_HOGS, WORLD_ITEMS, WORLD_REGION_ROWS, WORLD_SPAWN, WORLD_TILES, WORLD_TREES } from "./world-map";

// regionAt() reads the committed grid on both client and module
setRegionRows(WORLD_REGION_ROWS);
/**
 * Tuning values from the GDD. Those marked (initial) are starting values; keep
 * them centralized here and make them remotely configurable only when runtime
 * tuning or experiments are useful. See docs/gdd.md.
 */

import { BIG_HOG_STYLES, hogSize } from "./creatures";

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
 * Per-zone entity ceilings (GDD "Data model"). The Commands panel and carried-object
 * drops insert boulders/Hogs/items into the shared zone, so the server refuses once a
 * zone is at its cap — a scripted client can't flood a zone with entities and inflate
 * every `wanderHogs` tick.
 * Enforced server-side (invariant 3); the client feature flags only gate the UI, not the
 * reducer. Far above the registry seeds (2 boulders, 6 Hogs) — purely a DoS ceiling. (initial)
 */
export const MAX_HOGS_PER_ZONE = 192;
export const MAX_BOULDERS_PER_ZONE = 224;
export const MAX_TREES_PER_ZONE = 320;
export const MAX_GROUND_ITEMS_PER_ZONE = 384;

/** Chat. (initial) */
export const CHAT_MAX_CHARS = 200;
export const CHAT_BUBBLE_MS = 5_000;
export const CHAT_RATE_LIMIT_MS = 1_000;
/** Recent messages kept in zone state for the side-panel history. (initial) */
export const CHAT_HISTORY_MAX = 50;

/**
 * Recent synced ghost haunts kept in zone state. Haunts are rendered only as fresh
 * inserts by live subscribers; this cap just prevents the cosmetic event table from
 * growing forever. (initial)
 */
export const GHOST_HAUNT_HISTORY_MAX = 50;

/**
 * A `ghost_haunt` row only renders if it arrived this fresh. The initial subscription
 * snapshot replays the zone's capped history to a joiner, so without a freshness gate
 * every persisted row would render at once (a swarm). Live inserts arrive within a
 * second; this window stays well clear of network latency and clock skew while
 * excluding any backlog row. (initial)
 */
export const GHOST_HAUNT_FRESH_MS = 10_000;

/** An integer tile coordinate within a zone. */
export interface Coord {
  x: number;
  y: number;
}

/** Item ids are canonical across inventory rows, equipment slots, and UI labels. */
export const ITEM_IDS = ["stone", "wood", "quill", "pickaxe", "shovel", "axe", "sword", "shield", "torch"] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export const SPAWNABLE_ITEM_IDS = ["pickaxe", "shovel", "axe", "sword", "shield", "torch"] as const satisfies readonly ItemId[];
export type SpawnableItemId = (typeof SPAWNABLE_ITEM_IDS)[number];

/** Inventory capacity (GDD "Inventory"): each row occupies one visible carry slot. (initial) */
export const INVENTORY_SLOT_COUNT = 20;

/** Trogg/Hog combat health, damage, and respawn timing. (initial) */
export const PLAYER_MAX_HEALTH = 100;
export const HOG_MAX_HEALTH = 60;

/** A Hog's max health scales with the area of its footprint: a 2×2 giant is
 *  four commons' worth of hedgehog. (initial) */
export function hogMaxHealth(style: string): number {
  const size = hogSize(style);
  return HOG_MAX_HEALTH * size * size;
}

/**
 * Out-of-combat regeneration (GDD "Combat"): a creature untouched for
 * `HEALTH_REGEN_DELAY_MS` heals `HEALTH_REGEN_FRACTION` of its max (rounded up)
 * every `HEALTH_REGEN_TICK_MS`, driven by the scheduled `regenCreatures` sweep
 * (the sanctioned timer exception, like `wanderHogs`). Dead troggs never regen.
 * (initial)
 */
export const HEALTH_REGEN_DELAY_MS = 30_000;
export const HEALTH_REGEN_TICK_MS = 3_000;
export const HEALTH_REGEN_FRACTION = 0.05;

/** How long a dead NPC lies where it fell before the corpse is reaped (troggs
 *  instead respawn after PLAYER_RESPAWN_MS). Corpses are scenery: not solid,
 *  not targetable, not liftable. (initial) */
export const NPC_CORPSE_MS = 30_000;

/** How far (tiles, centre to centre) `E` reaches for ground items — a radius,
 *  not a facing, so a drop at your feet is always liftable. (initial) */
export const ITEM_PICKUP_RADIUS = 1.75;

/** One entry of a creature's loot table: an inclusive quantity range rolled
 *  with the reducer's context RNG when the creature dies. */
export interface LootRoll {
  item: ItemId;
  min: number;
  max: number;
}

/**
 * What a Hog leaves behind (GDD "Combat"): loot lands as ground items on the
 * nearest free tiles around the corpse. A giant sheds proportionally more.
 * Troggs need no table — their loot is whatever they carried and held, which
 * death already drops. (initial)
 */
export function hogLoot(style: string): LootRoll[] {
  return hogSize(style) > 1 ? [{ item: "quill", min: 4, max: 6 }] : [{ item: "quill", min: 1, max: 2 }];
}

/** Gathering-node health: a boulder or tree soaks a few tool swings (each rolls
 *  the tool's WEAPON_DAMAGE range) before it breaks and grants its resource —
 *  roughly three average hits each. (initial) */
export const BOULDER_MAX_HEALTH = 45;
export const TREE_MAX_HEALTH = 54;

/**
 * Per-weapon melee damage as an inclusive [floor, ceiling] — every accepted hit
 * rolls inside its weapon's range with the reducer's context RNG, so no two
 * swings feel identical but replay stays deterministic (GDD "Combat"). Every
 * equippable main-hand item can hurt a trogg or Hog, the sword just does it
 * best. Tools resolve their gathering target first (pickaxe → boulder,
 * axe → tree) and only wound creatures when no node is in reach. Unlisted
 * items, off-hand items, and bare fists deal nothing. (initial)
 */
export const WEAPON_DAMAGE: Partial<Record<ItemId, readonly [number, number]>> = {
  sword: [20, 30],
  axe: [14, 22],
  pickaxe: [11, 19],
  shovel: [8, 16],
};

/** The melee damage range an equipped item rolls against creatures, if it can hurt them. */
export function weaponDamageRange(item: string): readonly [number, number] | undefined {
  return isItemId(item) ? WEAPON_DAMAGE[item] : undefined;
}

/** How much of a weapon's roll lands on a gathering node it wasn't made for —
 *  a sword CAN whittle a tree down, it's just a terrible saw. Applied to the
 *  roll, never below a 1-point scratch. (initial) */
export const OFF_TOOL_NODE_FACTOR = 0.08;

/** Bare fists: the empty-handed swing's damage range — always available, the
 *  weakest option. Stored as the "fists" action impulse so clients animate it. */
export const UNARMED_DAMAGE: readonly [number, number] = [5, 10];

/** The Commands-panel speed cheat's multiplier (GDD "Commands panel"). Also the
 *  ceiling `setCheats` clamps to — a forged call can't buy more (invariant 3). */
export const CHEAT_SPEED_MULTIPLIER = 3;

/** How long a visible equipment-use impulse lasts — the attack clip length. */
export const EQUIPMENT_ACTION_MS = 300;

/** Server-enforced floor between equipment uses: chaining at the swing cadence is
 *  fine, spamming faster than the animation is not. Slightly under
 *  EQUIPMENT_ACTION_MS so a hold-to-attack client never races the clock. */
export const EQUIPMENT_USE_COOLDOWN_MS = 250;
export const THROWN_OBJECT_DAMAGE = 40;
export const THROWN_OBJECT_RANGE = 4;
export const PLAYER_RESPAWN_MS = 5000;

export type EquipmentSlot = "mainHand" | "offHand";

/** How a weapon is used: the attack clip class every species plays for it.
 *  "swing" is the bare-fisted default. */
export type Wield = "swing" | "stab" | "chop" | "scoop";

export interface ItemDef {
  id: ItemId;
  name: string;
  stackable: boolean;
  blurb: string;
  slot?: EquipmentSlot;
  wield?: Wield;
}

/**
 * Static item registry (GDD "Inventory"). Inventory rows store only item id and
 * quantity; holdable items point at their equipment slot, and weapons at the
 * wield class that picks their attack animation.
 */
export const ITEMS: Record<ItemId, ItemDef> = {
  stone: {
    id: "stone",
    name: "Stone",
    stackable: true,
    blurb: "A useful chunk of cave rock.",
  },
  wood: {
    id: "wood",
    name: "Wood",
    stackable: true,
    blurb: "A stout length of felled trunk.",
  },
  quill: {
    id: "quill",
    name: "Quill",
    stackable: true,
    blurb: "A stiff Hog spine, shed by the fallen.",
  },
  pickaxe: {
    id: "pickaxe",
    name: "Pickaxe",
    stackable: false,
    blurb: "Equipped in the main hand. Use it to mine boulders into stone.",
    slot: "mainHand",
    wield: "chop",
  },
  shovel: {
    id: "shovel",
    name: "Shovel",
    stackable: false,
    blurb: "Equipped in the main hand. It is ready for digging once soil rules exist.",
    slot: "mainHand",
    wield: "scoop",
  },
  axe: {
    id: "axe",
    name: "Axe",
    stackable: false,
    blurb: "Equipped in the main hand. Use it to fell trees into wood.",
    slot: "mainHand",
    wield: "chop",
  },
  sword: {
    id: "sword",
    name: "Sword",
    stackable: false,
    blurb: "Equipped in the main hand. Use it to attack a faced adjacent trogg.",
    slot: "mainHand",
    wield: "stab",
  },
  shield: {
    id: "shield",
    name: "Shield",
    stackable: false,
    blurb: "Equipped in the off hand.",
    slot: "offHand",
  },
  torch: {
    id: "torch",
    name: "Torch",
    stackable: false,
    blurb: "Equipped in the off hand. Carries a pool of firelight into the dark.",
    slot: "offHand",
  },
};

export function isItemId(item: string): item is ItemId {
  return (ITEM_IDS as readonly string[]).includes(item);
}

export function isSpawnableItemId(item: string): item is SpawnableItemId {
  return (SPAWNABLE_ITEM_IDS as readonly string[]).includes(item);
}

export function isEquippableItem(item: string): item is ItemId {
  return isItemId(item) && ITEMS[item].slot !== undefined;
}

/** The equipment slot an item occupies, or undefined when it isn't equippable. */
export function equipSlotOf(item: string): EquipmentSlot | undefined {
  return isItemId(item) ? ITEMS[item].slot : undefined;
}

/** The attack clip class for a held item — bare-fisted "swing" when empty or unclassed. */
export function wieldOf(item: string): Wield {
  return (isItemId(item) ? ITEMS[item].wield : undefined) ?? "swing";
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
 *
 * `bigHogs` lists the zone's rare 2×2 showpiece Hogs (GDD "Hogs") — a buff or dino
 * placed at a chosen anchor (its top-left tile), seeded with an explicit `style` so
 * it never rolls from the random crowd. Each needs its whole 2×2 footprint clear of
 * walls; `assertZones` checks that.
 */
export interface BigHog {
  x: number;
  y: number;
  style: string;
}

/** A gate on a zone edge: standing on its tile and interacting travels to `to`,
 *  arriving inside that zone's reciprocal gate (GDD "Zones"). */
export interface ZoneExit {
  dir: "north" | "south" | "east" | "west";
  to: string;
  x: number;
  y: number;
}

export interface Zone {
  slug: string;
  name: string;
  width: number;
  height: number;
  /** Colour/decoration family — the client picks palettes by it (BIOME_3D). */
  biome: string;
  /** Edge gates into neighbouring zones. */
  exits: readonly ZoneExit[];
  /** Where fresh troggs appear; defaults to the zone centre when absent. */
  spawn?: Coord;
  tiles: readonly string[];
  boulders: readonly Coord[];
  /** Starting tiles of the zone's choppable trees — seeded like boulders, felled by an axe. */
  trees: readonly Coord[];
  hogs: readonly Coord[];
  items: readonly GroundItemSeed[];
  bigHogs: readonly BigHog[];
}

/**
 * The world (GDD "Zones"): ONE seamless zone, read from the committed map
 * (`shared/world-map.ts` — generated once by `bin/generate-world`, then owned by
 * hand). It is a plus-shaped layout of eleven biome regions (`WORLD_REGIONS` in
 * worldgen.ts) stitched into a single 192×220 coordinate space with natural
 * carved passages between them — regions are colour/decoration character and a
 * name for a part of the map, not instances; you walk across. The client streams
 * terrain in proximity chunks; the whole world is one subscription space.
 */
export const ZONES: Record<string, Zone> = {
  world: {
    slug: "world",
    name: "The Caves",
    width: WORLD_W,
    height: WORLD_H,
    biome: "cave",
    exits: [],
    spawn: WORLD_SPAWN,
    tiles: WORLD_TILES,
    boulders: WORLD_BOULDERS,
    trees: WORLD_TREES,
    hogs: WORLD_HOGS,
    items: WORLD_ITEMS,
    bigHogs: WORLD_BIG_HOGS,
  },
};

/** Where a fresh trogg spawns, and the default room the client joins. */
export const STARTING_ZONE_SLUG = "world";

/** Look up a zone definition, or undefined if the slug is unknown. */
export function getZone(slug: string): Zone | undefined {
  return ZONES[slug];
}

/**
 * Is the tile at (tileX, tileY) walkable in this zone? Out-of-bounds is
 * unwalkable, so movement clamps at the zone edge the same way it clamps at a
 * wall. Coordinates are integer tile indices.
 */
/** The glyph at a tile, or undefined out of bounds. */
export function tileGlyph(zone: Zone, tileX: number, tileY: number): string | undefined {
  return zone.tiles[tileY]?.[tileX];
}

/** Walkable AND dry: where things may be placed and ambient creatures roam —
 *  a trogg wades through shallow water, but items don't float and Hogs keep to
 *  the banks (GDD "Zones"). */
export function isDryFloor(zone: Zone, tileX: number, tileY: number): boolean {
  return isWalkable(zone, tileX, tileY) && tileGlyph(zone, tileX, tileY) !== WATER_TILE;
}

export function isWalkable(zone: Zone, tileX: number, tileY: number): boolean {
  if (tileX < 0 || tileY < 0 || tileY >= zone.tiles.length) return false;
  const row = zone.tiles[tileY]!;
  if (tileX >= row.length) return false;
  return !SOLID_GLYPHS.has(row[tileX]!);
}

/**
 * Guard that every zone's tilemap matches its declared dimensions — a typo in a
 * row length would silently break collision, so fail loudly instead. Called by a
 * unit test; cheap enough to also run at module load if ever needed.
 */
export function assertZones(zones: Record<string, Zone> = ZONES): void {
  for (const zone of Object.values(zones)) {
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
    for (const tr of zone.trees) {
      if (!isDryFloor(zone, tr.x, tr.y)) {
        throw new Error(`zone ${zone.slug}: tree at (${tr.x}, ${tr.y}) is not on dry open floor`);
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
    for (const exit of zone.exits) {
      if (!isWalkable(zone, exit.x, exit.y)) {
        throw new Error(`zone ${zone.slug}: ${exit.dir} gate at (${exit.x}, ${exit.y}) is not walkable`);
      }
      const target = zones[exit.to];
      if (!target) {
        throw new Error(`zone ${zone.slug}: ${exit.dir} gate leads to unknown zone ${JSON.stringify(exit.to)}`);
      }
      const opposite = { north: "south", south: "north", east: "west", west: "east" }[exit.dir];
      if (!target.exits.some((back) => back.dir === opposite && back.to === zone.slug)) {
        throw new Error(`zone ${zone.slug}: ${exit.dir} gate to ${exit.to} has no reciprocal gate back`);
      }
    }
    for (const h of zone.bigHogs) {
      if (!(BIG_HOG_STYLES as readonly string[]).includes(h.style)) {
        throw new Error(`zone ${zone.slug}: big hog at (${h.x}, ${h.y}) has non-big style ${JSON.stringify(h.style)}`);
      }
      // Every tile of the 2×2 footprint must be clear floor.
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        if (!isWalkable(zone, h.x + dx, h.y + dy)) {
          throw new Error(`zone ${zone.slug}: big hog at (${h.x}, ${h.y}) footprint tile (${h.x + dx}, ${h.y + dy}) is not walkable`);
        }
      }
    }
  }
}
