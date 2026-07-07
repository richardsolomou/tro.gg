export * from "./glyphs";
import { SOLID_GLYPHS, TILE_GLYPHS, WATER_TILE } from "./glyphs";
import { DARK_CREATURE_SPECIES, type DarkCreatureSpecies } from "./creatures";
import { generateBirthCave, HEARTH_STARTER_ITEMS, neighborsOf, regionAt, WORLD_SPAWN, worldGlyphAt } from "./worldgen";
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
 * A wanderer's turn/idle rolls (AFK troggs today, dark creatures once they
 * exist): a scheduled reducer re-derives the wanderer's settled position each
 * tick and either keeps its heading or rolls a fresh one, riding the same
 * intent-based motion as troggs (no per-frame sync). A moving wanderer keeps
 * its heading unless the way ahead is blocked or a `WANDER_TURN_CHANCE` roll
 * turns it; a fresh heading lands on idle with `WANDER_IDLE_CHANCE` so it
 * pauses rather than marching nonstop. (initial)
 */
export const WANDER_IDLE_CHANCE = 0.25;
export const WANDER_TURN_CHANCE = 0.15;

/**
 * Per-zone entity ceilings (GDD "Data model"). The Commands panel and carried-object
 * drops insert boulders/items into the shared zone, so the server refuses once a
 * zone is at its cap — a scripted client can't flood a zone with entities.
 * Enforced server-side (invariant 3); the client feature flags only gate the UI, not the
 * reducer. Far above the registry seeds (2 boulders) — purely a DoS ceiling. (initial)
 */
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
export const ITEM_IDS = ["stone", "wood", "pickaxe", "shovel", "axe", "sword", "shield", "torch"] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export const SPAWNABLE_ITEM_IDS = ["pickaxe", "shovel", "axe", "sword", "shield", "torch", "stone", "wood"] as const satisfies readonly ItemId[];
export type SpawnableItemId = (typeof SPAWNABLE_ITEM_IDS)[number];

/** Inventory capacity (GDD "Inventory"): each row occupies one visible carry slot. (initial) */
export const INVENTORY_SLOT_COUNT = 20;

/** The tribe's one shared resource pool (GDD "The fire and the dark" → The
 *  stockpile): a per-item cap so a long-idle tribe can't bank enough surplus
 *  to stall the dark indefinitely. A full pool doesn't grow further — gathering
 *  past the cap is wasted effort. (initial) */
export const STOCKPILE_CAP = 2000;

/**
 * Hearths and braziers (GDD "The fire and the dark" → Territory and
 * permanence). `BRAZIER_LIT_RADIUS`/`FIRST_FIRE_LIT_RADIUS` size each
 * brazier's glow ring — by day safety is region-wide (`isLitTile`) and the
 * ring is presentation; at night the ring is the sanctuary creatures cannot
 * enter (GDD "The fire and the dark" → Night; `isSanctuaryTile`). The
 * First Fire's is wider since it anchors the whole hub. Upkeep is billed in Wood — a
 * lit brazier draws `BRAZIER_UPKEEP_RATE` from the stockpile every
 * `BRAZIER_UPKEEP_TICK_MS`; when the tribe can't cover total upkeep, braziers
 * furthest from the First Fire gutter first (never the interior, never at
 * random) until what's left is affordable. The First Fire itself never
 * gutters, however long it goes unpaid. (initial)
 */
export const BRAZIER_LIT_RADIUS = 6;
export const FIRST_FIRE_LIT_RADIUS = 10;
/** Stone drawn from the stockpile to set a claim brazier down (GDD
 *  "Territory claiming") — the fight buys the right, the stone builds the
 *  fire, so expansion is a tribe-level economic decision. Relighting a
 *  guttered brazier stays free. (initial) */
export const BRAZIER_CLAIM_STONE_COST = 20;
export const BRAZIER_UPKEEP_ITEM: ItemId = "wood";
export const BRAZIER_UPKEEP_RATE = 1;
export const BRAZIER_UPKEEP_TICK_MS = 30_000;

/**
 * Presence: active or AFK (GDD "The fire and the dark" → Presence).
 * The AFK charge (`kindlingCharge` on the player row — the column keeps its
 * shipped name; prod schema changes only additively) is stored the way
 * motion is — a value plus the anchor it was true at — so its current value
 * is *derived* by applying the accrual rate while active or the decay rate
 * while AFK, never advanced on a timer (invariant 1; see `deriveAfkCharge`).
 * Decaying faster than it accrues means keeping a trogg productive while
 * away costs the same thing it always should: showing up. (initial)
 */
export const AFK_CHARGE_ACCRUAL_RATE = 1; // charge per minute of active play
export const AFK_CHARGE_MAX = 60;
export const AFK_CHARGE_DECAY_RATE = 10; // charge per hour while AFK

/**
 * AFK work is unlocked once, ever, by real play (GDD "Presence" — the
 * eligibility gate): a trogg's total XP across all skills must reach this
 * before a disconnect leaves it working in the world at all. Below the gate,
 * going offline is a plain offline — hidden, no instinct, no trickle — so a
 * horde of fresh incognito guests farms nothing while away. 800 XP = overall
 * level 5, roughly one genuinely played first session. (initial)
 */
export const AFK_UNLOCK_XP = 800;

/**
 * An AFK trogg works safe interior ground on instinct (GDD "Presence"):
 * the scheduled `ember_wander` sweep (durable table name predates the AFK
 * naming) re-derives its position every
 * `AFK_WANDER_TICK_MS`, routes it to the nearest boulder or tree on lit
 * revealed ground, and camps it there, rolling a per-tick chance for an
 * instinct-driven gather chip roughly the weight of one weak tool hit —
 * deposited into the stockpile the same way a real hit is, earning no XP.
 * The roll is `AFK_EFFICIENCY_FRACTION` while AFK charge lasts; once the
 * charge is spent it drops to `AFK_TRICKLE_EFFICIENCY_FRACTION` and winds
 * down linearly to zero across `AFK_HIDE_AFTER_MS` of absence (see
 * `afkGatherFraction`), at which point the trogg is hidden from the world
 * entirely until its player returns — the settlement reads as the tribe
 * that actually plays here, not a museum. Offline time is measured from the
 * disconnect anchor (`kindlingChargeAt`). `AFK_SEEK_RADIUS`
 * (manhattan tiles) is the routing budget, sized to span a whole settled zone
 * rather than a neighbourhood — park a trogg anywhere lit and it works that
 * ground. With no reachable node it falls back to an aimless wander. (initial)
 */
export const AFK_EFFICIENCY_FRACTION = 0.3;
export const AFK_TRICKLE_EFFICIENCY_FRACTION = 0.1;
export const AFK_WANDER_TICK_MS = 1_000;
export const AFK_GATHER_DAMAGE = 6;
export const AFK_SEEK_RADIUS = 400;
export const AFK_HIDE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // a week away hides the trogg (initial)

/** Trogg combat health, damage, and respawn timing. (initial) */
export const PLAYER_MAX_HEALTH = 100;

/**
 * Out-of-combat regeneration (GDD "Combat"): a trogg untouched for
 * `HEALTH_REGEN_DELAY_MS` heals `HEALTH_REGEN_FRACTION` of its max (rounded up)
 * every `HEALTH_REGEN_TICK_MS`, driven by the scheduled `regenCreatures` sweep
 * (a sanctioned timer exception). Dead troggs never regen. (initial)
 */
export const HEALTH_REGEN_DELAY_MS = 30_000;
export const HEALTH_REGEN_TICK_MS = 3_000;
export const HEALTH_REGEN_FRACTION = 0.05;

/** How far (tiles, centre to centre) `E` reaches for ground items — a radius,
 *  not a facing, so a drop at your feet is always liftable. (initial) */
export const ITEM_PICKUP_RADIUS = 1.75;

/** Gathering-node health: a boulder or tree soaks a few tool swings (each rolls
 *  the tool's WEAPON_DAMAGE range) before it breaks and grants its resource —
 *  roughly three average hits each. (initial) */
export const BOULDER_MAX_HEALTH = 45;
export const TREE_MAX_HEALTH = 54;

/** How long a broken node stays gone before it respawns in place (GDD
 *  "Territory claiming"): a one-shot `node_respawn` row per breaking hit, so
 *  settled ground never runs dry however long a trogg farms it. (initial) */
export const NODE_RESPAWN_MS = 30_000;

/**
 * Per-weapon melee damage as an inclusive [floor, ceiling] — every accepted hit
 * rolls inside its weapon's range with the reducer's context RNG, so no two
 * swings feel identical but replay stays deterministic (GDD "Combat"). Every
 * equippable main-hand item can hurt a trogg, the sword just does it best.
 * Tools resolve their gathering target first (pickaxe → boulder, axe → tree)
 * and only wound a trogg when no node is in reach. Unlisted items, off-hand
 * items, and bare fists deal nothing. (initial)
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
 * Dark creatures (GDD "Dark creatures" / "The fire and the dark" → Territory
 * and permanence): hostile inhabitants of the dark, aggressive on sight, kept
 * off any lit ground by the hearth rule. `DARK_CREATURE_AGGRO_RANGE` is how
 * close an active trogg must come to break a creature's wander into a chase.
 * `NPC_CORPSE_MS` is how long a killed creature lies as a corpse before the
 * regen sweep reaps it — whether a fresh one then takes its place depends on
 * whether the ground is lit at that moment (evaluated at the reap, not the
 * kill — the two are seconds apart at most, and reap-time keeps the rule a
 * pure function of current territory rather than a decision frozen at death).
 * Per-species stats live in `DARK_CREATURES`, so a new species is a model
 * builder (`src/game/creatures.ts`) and a row here. (initial)
 */
export const DARK_CREATURE_AGGRO_RANGE = 6;
export const NPC_CORPSE_MS = 30_000;
export const MAX_DARK_CREATURES_PER_ZONE = 120;

export interface DarkCreatureDef {
  species: DarkCreatureSpecies;
  name: string;
  maxHealth: number;
  damage: readonly [number, number];
  hitRadius: number;
  loot: { item: ItemId; qty: readonly [number, number] };
}

export const DARK_CREATURES: Record<DarkCreatureSpecies, DarkCreatureDef> = {
  grask: {
    species: "grask",
    name: "Grask",
    maxHealth: 40,
    damage: [6, 12],
    hitRadius: 0.5,
    // A placeholder drop until the bestiary earns its own loot table (see
    // docs/gdd.md "Open design threads" — content, not engine work).
    loot: { item: "stone", qty: [1, 2] },
  },
};

export function isDarkCreatureSpecies(species: string): species is DarkCreatureSpecies {
  return (DARK_CREATURE_SPECIES as readonly string[]).includes(species);
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

/** A dark creature's starting tile and species (GDD "Dark creatures") —
 *  seeded like a boulder or tree, but into the `dark_creature` table rather
 *  than a static registry, since it wanders. */
export interface DarkCreatureSeed extends Coord {
  species: DarkCreatureSpecies;
}

export interface Zone {
  slug: string;
  name: string;
  /** Tile extents of a bounded zone's committed grid; 0 when `unbounded`. */
  width: number;
  height: number;
  /** The world zone has no edge (GDD "Generation"): tiles synthesize on demand
   *  from coordinates — negative included — and `tiles` stays empty. */
  unbounded?: boolean;
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
  /** Starting dark-creature population — empty for the private birth cave. */
  darkCreatures: readonly DarkCreatureSeed[];
  /** Where `E` emerges from an instanced birth cave (GDD "Onboarding"). */
  exit?: Coord;
}

/**
 * The world (GDD "Zones"): ONE seamless, unbounded zone. There is no committed
 * map — every tile's glyph is synthesized on demand from its coordinates and
 * the world seed (`worldGlyphAt`, shared/worldgen.ts), identically on client
 * and module, so the grid stays shared design data with no file enumerating
 * it and no edge to run out of. Regions are a colour/decoration character and
 * a name for a part of the map, not instances; per-region seeds (boulders,
 * trees, dark creatures) come from `regionSeeds` and are inserted by the
 * module the moment a region is first exposed. The client streams terrain in
 * proximity chunks; the whole world is one subscription space.
 */
export const ZONES: Record<string, Zone> = {
  world: {
    slug: "world",
    name: "The Caves",
    width: 0,
    height: 0,
    unbounded: true,
    biome: "cave",
    exits: [],
    spawn: WORLD_SPAWN,
    tiles: [],
    boulders: [],
    trees: [],
    items: HEARTH_STARTER_ITEMS,
    cells: [],
    darkCreatures: [],
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

/** Where a fresh trogg spawns, and the default room the client joins. */
export const STARTING_ZONE_SLUG = "world";

/** Look up a zone definition, or undefined if the slug is unknown. */
export function getZone(slug: string): Zone | undefined {
  if (isBirthZone(slug)) return ZONES["birthcave"];
  return ZONES[slug];
}

/**
 * Lazy, region-at-a-time worldgen (GDD "Generation: only as far as the light
 * reaches"): the durable truth is which of the 11 world regions the tribe has
 * claimed (an ignited brazier there), not a distance ring from the Hearth. A
 * region is **interior** (`revealedSlugs`, claimed), **penumbra** (adjacent to
 * an interior region via the committed `WORLD_REGION_ADJACENCY` graph, not yet
 * claimed — walkable, dangerous, scoutable), or **unreached** (neither — a
 * hard collision wall regardless of what's rendered there; see `regionVisibility`
 * for how that differs from what's drawn). Penumbra is derived on demand, never stored.
 */
export function penumbraOf(revealedSlugs: ReadonlySet<string>): ReadonlySet<string> {
  const penumbra = new Set<string>();
  for (const slug of revealedSlugs) {
    for (const neighbor of neighborsOf(slug)) {
      if (!revealedSlugs.has(neighbor)) penumbra.add(neighbor);
    }
  }
  return penumbra;
}

/** Whether a tile is revealed ground — interior or penumbra. Always true
 *  outside the world zone (birth caves have no region concept) and for
 *  tiles with no region (void/ocean, already unwalkable). Callers compute
 *  `revealedSlugs`/`penumbraSlugs` once per bounds construction, not per tile. */
export function isRevealed(zone: Zone, revealedSlugs: ReadonlySet<string>, penumbraSlugs: ReadonlySet<string>, x: number, y: number): boolean {
  if (zone.slug !== STARTING_ZONE_SLUG) return true;
  const region = regionAt(x, y);
  return revealedSlugs.has(region.slug) || penumbraSlugs.has(region.slug);
}

/** The three fog-of-war states a world-zone tile can be in (GDD "Generation:
 *  only as far as the light reaches"): **interior** renders and plays
 *  normally; **penumbra** renders its real terrain — walkable, dangerous —
 *  under a light fog, since it's scoutable, not tamed; **unreached** renders
 *  its real terrain too, under a heavy fog, but stays a hard collision wall
 *  regardless (`isRevealed`) — fogged, never a solid substitute tile, so what
 *  lies beyond always reads as unclear rather than nonexistent. Always
 *  "interior" outside the world zone or off the region grid. */
export type RegionVisibility = "interior" | "penumbra" | "unreached";

export function regionVisibility(zone: Zone, revealedSlugs: ReadonlySet<string>, penumbraSlugs: ReadonlySet<string>, x: number, y: number): RegionVisibility {
  if (zone.slug !== STARTING_ZONE_SLUG) return "interior";
  const region = regionAt(x, y);
  if (revealedSlugs.has(region.slug)) return "interior";
  return penumbraSlugs.has(region.slug) ? "penumbra" : "unreached";
}

/**
 * Is the tile at (tileX, tileY) walkable in this zone? Out-of-bounds is
 * unwalkable, so movement clamps at the zone edge the same way it clamps at a
 * wall. Coordinates are integer tile indices.
 */
/** The glyph at a tile, or undefined out of a bounded zone's grid. The
 *  unbounded world synthesizes every tile on demand (invariant 7). */
export function tileGlyph(zone: Zone, tileX: number, tileY: number): string | undefined {
  if (zone.unbounded) return worldGlyphAt(tileX, tileY);
  return zone.tiles[tileY]?.[tileX];
}

/** Walkable AND dry: where things may be placed and ambient creatures roam —
 *  a trogg wades through shallow water, but items don't float and ambient
 *  creatures keep to the banks (GDD "Zones"). */
export function isDryFloor(zone: Zone, tileX: number, tileY: number): boolean {
  return isWalkable(zone, tileX, tileY) && tileGlyph(zone, tileX, tileY) !== WATER_TILE;
}

export function isWalkable(zone: Zone, tileX: number, tileY: number): boolean {
  if (zone.unbounded) return !SOLID_GLYPHS.has(worldGlyphAt(tileX, tileY));
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
    if (zone.unbounded) {
      // no committed grid to validate — check the fixed anchors instead;
      // the generator's own invariants are covered by the worldgen tests
      const spawn = zone.spawn ?? { x: 0, y: 0 };
      if (!isWalkable(zone, spawn.x, spawn.y)) {
        throw new Error(`zone ${zone.slug}: spawn at (${spawn.x}, ${spawn.y}) is not walkable`);
      }
      for (const item of zone.items) {
        if (!isItemId(item.item)) {
          throw new Error(`zone ${zone.slug}: ground item ${JSON.stringify(item.item)} is not registered`);
        }
        if (!isWalkable(zone, item.x, item.y)) {
          throw new Error(`zone ${zone.slug}: ground item ${item.item} at (${item.x}, ${item.y}) is not on walkable floor`);
        }
      }
      continue;
    }
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
