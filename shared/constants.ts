export * from "./glyphs";
import { SOLID_GLYPHS, TILE_GLYPHS, WATER_TILE } from "./glyphs";
import { generateBirthCave, setRegionRows, WORLD_H, WORLD_W } from "./worldgen";
import { WORLD_ARRIVAL, WORLD_CAVE_DOOR, WORLD_BOULDERS, WORLD_CELLS, WORLD_DARK_CREATURES, WORLD_ITEMS, WORLD_REGION_ROWS, WORLD_SPAWN, WORLD_TILES, WORLD_TREES } from "./world-map";

// regionAt() reads the committed grid on both client and module
setRegionRows(WORLD_REGION_ROWS);
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
 * Per-zone entity ceilings (GDD "Data model"). The Commands panel and carried-object
 * drops insert boulders/items into the shared zone, so the server refuses once a zone
 * is at its cap — a scripted client can't flood a zone with entities.
 * Enforced server-side (invariant 3); the client feature flags only gate the UI, not the
 * reducer. Far above the registry seeds — purely a DoS ceiling. (initial)
 */
export const MAX_BOULDERS_PER_ZONE = 224;
export const MAX_TREES_PER_ZONE = 320;
export const MAX_GROUND_ITEMS_PER_ZONE = 384;

/**
 * The tribe's shared stockpile (GDD "The fire and the dark" → The stockpile): one
 * global pool per item, fed directly by every gather action. A full pool doesn't
 * grow further — gathering past the cap is wasted effort. Sized to a few days of
 * the tribe's total upkeep at the current brazier count. (initial)
 */
export const STOCKPILE_CAP = 10_000;

/**
 * Hearths and braziers (GDD "The fire and the dark" → Territory and permanence):
 * every hearth casts a lit radius dark creatures cannot enter. The First Fire at
 * the Hearth is `isEternal` and never gutters; every other brazier drains
 * `BRAZIER_UPKEEP_ITEM` from the stockpile at `BRAZIER_UPKEEP_RATE` per tick of
 * `BRAZIER_UPKEEP_TICK_MS` for as long as it burns. Wood is the upkeep fuel — the
 * same resource an ignition's fuel cost draws from (see Ignition, below). When the
 * stockpile can't cover total upkeep, the brazier(s) furthest from the First Fire
 * gutter first, one at a time, never the interior — the outermost-first recession
 * rule. Guttered braziers relight only through a successful ignition (below), never
 * automatically once the stockpile recovers. (initial)
 */
export const FIRST_FIRE_RADIUS = 16;
export const BRAZIER_RADIUS = 8;
export const BRAZIER_UPKEEP_ITEM: StockpileItemId = "wood";
export const BRAZIER_UPKEEP_RATE = 4;
export const BRAZIER_UPKEEP_TICK_MS = 60_000;

/**
 * Presence: bright, ember, dormant (GDD "The fire and the dark" → Presence).
 * `kindlingCharge` is denominated in milliseconds of ember-time remaining, stored
 * the same way motion is — a value plus the anchor (`kindlingChargeAt`) it was
 * true at — so the current value is *derived* by applying the accrual ratio over
 * elapsed real time while bright, or spending it 1:1 against elapsed real time
 * while ember (invariant 1: never advanced on a timer). `CHARGE_ACCRUAL_RATE` is
 * ms of charge earned per ms of bright play; `CHARGE_DECAY_RATE` is ms of charge
 * spent per ms of ember time (1 — ember time literally draws down the budget it
 * was banked as). A trogg with zero derived charge is dormant, not ember. (initial)
 */
export const CHARGE_ACCRUAL_RATE = 0.5;
export const CHARGE_DECAY_RATE = 1;
export const CHARGE_MAX_MS = 4 * 60 * 60 * 1000;

/** An ember trogg's gather rate relative to a bright trogg's (GDD "Skills and XP",
 *  "The fire and the dark" → Presence): instinct, not judgment, works slower and
 *  earns no XP. Expressed as the interval between ember deposits, sized so the
 *  effective rate is roughly EMBER_EFFICIENCY_FRACTION of a bright trogg mining a
 *  stone node (one node's yield per GATHER_ACTION_MS). (initial) */
export const EMBER_EFFICIENCY_FRACTION = 0.3;
export const GATHER_ACTION_MS = 3_000;
export const EMBER_GATHER_INTERVAL_MS = Math.round(GATHER_ACTION_MS / EMBER_EFFICIENCY_FRACTION);

/** How often the ember/dark-creature wander sweep ticks (GDD "The fire and the
 *  dark" → Presence, "Dark creatures") — the direct successor of the retired
 *  Hog-wander cadence. (initial) */
export const EMBER_WANDER_TICK_MS = 1_000 / MOVE_SPEED_TILES_PER_SEC;
export const WANDER_TURN_CHANCE = 0.15;
export const WANDER_IDLE_CHANCE = 0.25;

/**
 * Dark creatures (GDD "Dark creatures"): hostile, light-bound inhabitants of the
 * dark and the penumbra. `DARK_CREATURE_MAX_HEALTH` and `DARK_CREATURE_AGGRO_RANGE`
 * are for the first bestiary entry (the wretch); species variety is open (see
 * Roadmap). Aggro is range-based, like earshot — no stealth or line-of-sight model
 * yet. (initial)
 */
export const DARK_CREATURE_MAX_HEALTH = 70;
export const DARK_CREATURE_AGGRO_RANGE = 6;
export const MAX_DARK_CREATURES_PER_ZONE = 96;

/** A dark creature's own attack, on the same swing/hit-circle grammar as a
 *  trogg's (GDD "Dark creatures" → "aggressive on sight... attacks on the same
 *  swing/hit-circle grammar as a trogg"). (initial) */
export const DARK_CREATURE_DAMAGE: readonly [number, number] = [8, 16];

/** How often a dark creature can land its own attack (GDD "Dark creatures" —
 *  slow and stat-driven, invariant 7: no twitch combat). Slower than the
 *  wander tick, so a chase doesn't read as a machine-gun swing. (initial) */
export const DARK_CREATURE_ATTACK_COOLDOWN_MS = 1_200;

/** A dark creature's loot (GDD "Dark creatures" → Combat): what a kill leaves
 *  behind, same drop/decay/cap mechanics as any other corpse. (initial) */
export function darkCreatureLoot(): LootRoll[] {
  return [{ item: "stone", min: 1, max: 2 }];
}

/** An ember-heart's drop chance (GDD "The fire and the dark" → Ignition):
 *  "recovered only by scouting beyond the frontline" — a kill on ground still
 *  lit by no hearth has a chance to leave one behind; a kill on already-lit,
 *  claimed ground never does (that ground isn't "the dark" being scouted). (initial) */
export const EMBER_HEART_DROP_CHANCE = 0.15;

/**
 * Ignition (GDD "The fire and the dark" → Ignition): pushing the frontline
 * outward is a deliberate hold-the-point event, not a threshold quietly crossed.
 * `IGNITION_FUEL_COST` is drawn from the stockpile's `BRAZIER_UPKEEP_ITEM`,
 * sized well above ordinary upkeep; the second key is a carried ember-heart,
 * recovered only by killing a dark creature beyond the frontline. `IGNITION_WINDOW_MS`
 * is a hold, not an hour-long raid — sized for a handful of concurrent players. (initial)
 */
export const IGNITION_FUEL_COST = 500;
export const IGNITION_WINDOW_MS = 3 * 60_000;
export const IGNITION_RANGE_TILES = 3;

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
export const ITEM_IDS = ["stone", "wood", "pickaxe", "shovel", "axe", "sword", "shield", "torch", "ember-heart"] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export const SPAWNABLE_ITEM_IDS = ["pickaxe", "shovel", "axe", "sword", "shield", "torch", "stone", "wood"] as const satisfies readonly ItemId[];
export type SpawnableItemId = (typeof SPAWNABLE_ITEM_IDS)[number];

/** Item ids that deposit into the shared stockpile on gather rather than a
 *  player's own inventory (GDD "Inventory" / "The fire and the dark"). */
export const STOCKPILE_ITEM_IDS = ["stone", "wood"] as const satisfies readonly ItemId[];
export type StockpileItemId = (typeof STOCKPILE_ITEM_IDS)[number];
export function isStockpileItemId(item: string): item is StockpileItemId {
  return (STOCKPILE_ITEM_IDS as readonly string[]).includes(item);
}

/** The one carryable ground find today (GDD "Interacting" / "The fire and the
 *  dark" → Ignition): recovered from a dark-creature kill, picked up into
 *  `carrying` rather than personal inventory, and delivered by putting it down
 *  at an ignition site. Not spawnable from the Commands panel. */
export const EMBER_HEART_ITEM: ItemId = "ember-heart";

/** Inventory capacity (GDD "Inventory"): each row occupies one visible carry slot. (initial) */
export const INVENTORY_SLOT_COUNT = 20;

/** Trogg combat health, damage, and respawn timing. (initial) */
export const PLAYER_MAX_HEALTH = 100;

/**
 * Out-of-combat regeneration (GDD "Combat"): a creature untouched for
 * `HEALTH_REGEN_DELAY_MS` heals `HEALTH_REGEN_FRACTION` of its max (rounded up)
 * every `HEALTH_REGEN_TICK_MS`, driven by the scheduled `regenCreatures` sweep
 * (a sanctioned timer exception — invariant 1). Dead troggs never regen.
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

/** Gathering-node health: a boulder or tree soaks a few tool swings (each rolls
 *  the tool's WEAPON_DAMAGE range) before it breaks and grants its resource —
 *  roughly three average hits each. (initial) */
export const BOULDER_MAX_HEALTH = 45;
export const TREE_MAX_HEALTH = 54;

/**
 * Per-weapon melee damage as an inclusive [floor, ceiling] — every accepted hit
 * rolls inside its weapon's range with the reducer's context RNG, so no two
 * swings feel identical but replay stays deterministic (GDD "Combat"). Every
 * equippable main-hand item can hurt a trogg, the sword just does it
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

/** A shield's toughness: the fraction of every incoming hit its wearer blocks
 *  while it's equipped in the off hand (GDD "Combat"), applied in
 *  `damagePlayer` against melee and thrown damage alike. (initial) */
export const SHIELD_BLOCK_FRACTION = 0.3;

/** Bare fists: the empty-handed swing's damage range — always available, the
 *  weakest option. Stored as the "fists" action impulse so clients animate it. */
export const UNARMED_DAMAGE: readonly [number, number] = [5, 10];

/** The Commands-drawer speed cheat's multiplier (GDD "Debug cheats"). Also the
 *  ceiling `setCheats` clamps to — a forged call can't buy more (invariant 3). */
export const CHEAT_SPEED_MULTIPLIER = 3;

/** Fly cheat (GDD "Debug cheats"): climb/sink rate, the altitude ceiling, and
 *  the heights airborne movement must clear — deep water is flat and scattered
 *  obstacles (trees, boulders, creatures) reach canopy height; rock walls use
 *  their actual rendered per-tile height (`rockHeightAt`, shared/heights.ts),
 *  so "just above the rock you can see" is exactly what clears. All shared:
 *  the projection is the one authority on where a flyer passes (invariant 3). */
export const FLY_VERTICAL_TILES_PER_SEC = 5;
export const FLY_MAX_HEIGHT = 14;
export const FLY_CLEAR_WATER = 0.2;
export const FLY_CLEAR_OBSTACLE = 2;

/** How long a visible equipment-use impulse lasts — the attack clip length. */
export const EQUIPMENT_ACTION_MS = 300;

/** Server-enforced floor between equipment uses: chaining at the swing cadence is
 *  fine, spamming faster than the animation is not. Slightly under
 *  EQUIPMENT_ACTION_MS so a hold-to-attack client never races the clock. */
export const EQUIPMENT_USE_COOLDOWN_MS = 250;
export const THROWN_OBJECT_DAMAGE = 40;
export const THROWN_OBJECT_RANGE = 4;

/** The client's throw-arc duration by distance (cosmetic): how long the object
 *  visibly flies from the thrower's hands to where it lands. */
export const THROWN_FLIGHT_MS_PER_TILE = 70;
export const THROWN_FLIGHT_MIN_MS = 240;
export const THROWN_FLIGHT_MAX_MS = 650;
export function thrownFlightMs(distanceTiles: number): number {
  return Math.min(THROWN_FLIGHT_MAX_MS, Math.max(THROWN_FLIGHT_MIN_MS, distanceTiles * THROWN_FLIGHT_MS_PER_TILE));
}

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
  /** Fraction of incoming damage this item's wearer blocks while it's equipped
   *  in the off hand. Absent (or main-hand) items block nothing. */
  block?: number;
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
    blurb: "Equipped in the off hand. Blocks a fraction of every hit you take.",
    slot: "offHand",
    block: SHIELD_BLOCK_FRACTION,
  },
  torch: {
    id: "torch",
    name: "Torch",
    stackable: false,
    blurb: "Equipped in the off hand. Carries a pool of firelight into the dark.",
    slot: "offHand",
  },
  "ember-heart": {
    id: "ember-heart",
    name: "Ember-heart",
    stackable: false,
    blurb: "A coal recovered from the dark. Carry it to an ignition site.",
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

/** The fraction of incoming damage a held item blocks — 0 for anything without a `block` stat. */
export function blockFractionOf(item: string): number {
  return (isItemId(item) ? ITEMS[item].block : undefined) ?? 0;
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
 * `items` lists starter pickup items. A pickup has a registry item id and a tile;
 * pressing `E` while facing it moves the item into inventory and removes the row.
 */

/** A gate on a zone edge: standing on its tile and interacting travels to `to`,
 *  arriving inside that zone's reciprocal gate (GDD "Zones"). */
export interface ZoneExit {
  dir: "north" | "south" | "east" | "west";
  to: string;
  x: number;
  y: number;
}

/** One birth cell in the warren (GDD "Onboarding: the Warren"): a sealed 3×3
 *  room burrowed into the south-coast rock where a newborn trogg wakes. The
 *  corridor tiles are open floor in the tilemap but plugged with mineable
 *  rubble rows at assignment; the pickaxe seeds beside the spawn point. */
export interface BirthCellSeed extends Coord {
  corridor: readonly Coord[];
  pickaxe: Coord;
}

/** Whether a (fractional) position sits inside a birth cell's room or corridor. */
export function birthCellContains(cell: BirthCellSeed, x: number, y: number): boolean {
  const tx = Math.round(x);
  const ty = Math.round(y);
  if (Math.abs(tx - cell.x) <= 1 && Math.abs(ty - cell.y) <= 1) return true;
  return cell.corridor.some((t) => t.x === tx && t.y === ty);
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
  items: readonly GroundItemSeed[];
  /** The birth warren's cells; empty for zones without one. */
  cells: readonly BirthCellSeed[];
  /** Where `E` emerges from an instanced birth cave (GDD "Onboarding"). */
  exit?: Coord;
  /** Starting tiles of the zone's ambient dark creatures (GDD "Dark creatures");
   *  empty for zones without any — every birth cave, currently. */
  darkCreatures: readonly Coord[];
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
    items: WORLD_ITEMS,
    cells: WORLD_CELLS,
    darkCreatures: WORLD_DARK_CREATURES,
  },
  birthcave: generateBirthCave(),
};

/** Per-player birth zone ids: `birth:<identity hex>`. Rows scoped by such an id
 *  are one newborn's private copy of the shared `birthcave` template — nobody
 *  else subscribes to it, so onboarding is single-player by construction. */
export const BIRTH_ZONE_PREFIX = "birth:";

export function birthZoneFor(identityHex: string): string {
  return `${BIRTH_ZONE_PREFIX}${identityHex}`;
}

export function isBirthZone(slug: string): boolean {
  return slug.startsWith(BIRTH_ZONE_PREFIX);
}

/** Where an emerging trogg lands: the coast's cave-mouth alcove. */
export const EMERGE_ARRIVAL = WORLD_ARRIVAL;

/** The alcove's deep end: walking into it descends into your own birth cave —
 *  every trogg keeps its cave, and nobody else's cave is ever reachable. */
export const CAVE_DOOR = WORLD_CAVE_DOOR;

/** Where a fresh trogg spawns, and the default room the client joins. */
export const STARTING_ZONE_SLUG = "world";

/** Look up a zone definition, or undefined if the slug is unknown. */
export function getZone(slug: string): Zone | undefined {
  if (isBirthZone(slug)) return ZONES["birthcave"];
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
 *  a trogg wades through shallow water, but items don't float and roaming
 *  creatures keep to the banks (GDD "Zones"). */
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
  }
}
