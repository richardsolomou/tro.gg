import { schema, table, t, type InferSchema, type ProcedureCtx, type ReducerCtx } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  COLOR_UNSET,
  DARK_CREATURE_AGGRO_RANGE,
  DIR_SCALE,
  elapsedMs,
  STYLE_UNSET,
  HEALTH_REGEN_DELAY_MS,
  HEALTH_REGEN_FRACTION,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  meleeHit,
  NPC_CORPSE_MS,
  PLAYER_HIT_RADIUS,
  PLAYER_MAX_HEALTH,
  BRAZIER_UPKEEP_ITEM,
  BRAZIER_UPKEEP_RATE,
  deriveKindlingCharge,
  DORMANT_EFFICIENCY_FRACTION,
  EMBER_EFFICIENCY_FRACTION,
  EMBER_GATHER_DAMAGE,
  EMBER_SEEK_RADIUS,
  findPath,
  NODE_RESPAWN_MS,
  serializePath,
  smoothPath,
  WANDER_TURN_CHANCE,
  footprintWalkable,
  getZone,
  isRevealed,
  penumbraOf,
  projectMotionState,
  regionAt,
  tileKey,
  type Zone,
  zoneBounds,
} from "../../shared/index";
import {
  anyPlayerOnline,
  armRegen,
  armBrazierUpkeep,
  armEmberWander,
  respawnDue,
  scheduleRespawnAt,
  respawnPlayer,
  withdrawStockpile,
  depositStockpile,
  obstacleTiles,
  boulderAt,
  treeAt,
  isLitTile,
  pickWanderDir,
  settle,
  darkCreatureDef,
  damagePlayer,
  currentRevealedRegions,
  regionHopDepths,
  scheduleNodeRespawn,
} from "./helpers";

/**
 * The tro.gg backend (GDD "Data model"): durable tables that clients subscribe to
 * directly, mutated only by trusted module entrypoints: reducers, or procedures
 * that open a SpacetimeDB transaction before external telemetry. Identity is the
 * connection's own cryptographic `ctx.sender` (invariant 3: never client-asserted).
 * There is no simulation tick (invariant 1): state changes only inside a reducer,
 * a procedure transaction, or a lifecycle event; position between inputs is derived
 * with `projectMotion`, never advanced on a timer.
 */

/**
 * A trogg. The durable row is keyed by the player's Identity, so a returning
 * visitor who reconnects with the same stored token resumes the same trogg.
 * Motion is intent-based (invariants 1 & 2): the row holds an origin (x, y), a
 * WASD direction, `running`, and `movedAt`; position over time is derived, and
 * settled back into (x, y) on the next input or on disconnect. `faceX`/`faceY`
 * carry the standing facing separately from movement intent, so a tap-to-turn
 * syncs to other clients without pretending the trogg is walking. `running`
 * (shift held) rides the intent so every client derives the same speed (GDD "Movement").
 * `color` is the chosen avatar palette index (GDD "Avatars"), set by `recolor`; it
 * defaults to `COLOR_UNSET` (-1) so an unchosen trogg falls back to its id-derived
 * colour. `carrying` is the kind of tile-sized entity the trogg holds (GDD
 * "Interacting"), set by `interact`; "" when empty-handed. `carryingStyle`
 * carries a held entity's visual variant while its world row is gone. `style` is
 * the chosen avatar body style. `equippedMainHand` stores the item id currently shown in the
 * trogg's main hand (GDD "Inventory" / "Avatars and equipment").
 * `equippedMainHandInventoryId` points at the specific owned inventory row, so
 * duplicate swords/picks are distinct in the HUD even though everyone else only
 * needs the item id to render the held sprite. `equipmentAction` +
 * `equipmentActionAt` are the last visible equipment use impulse, so every client
 * can briefly animate a swing or chop from synced player state. `health`, `dead`,
 * and `respawnAt` are the pre-alpha combat state: damage reduces health, a dead
 * trogg stays online and inert for a visible countdown, then a scheduled reducer
 * returns it to spawn.
 */
const player = table(
  { name: "player", public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    isGuest: t.bool(),
    zoneId: t.string().index("btree"),
    x: t.f64(),
    y: t.f64(),
    dirX: t.i32(),
    dirY: t.i32(),
    movedAt: t.timestamp(),
    online: t.bool(),
    lastChatAt: t.option(t.timestamp()),
    // Append new columns here, at the end, each with a default. SpacetimeDB
    // auto-migrates an append-with-default in place, but inserting a column
    // mid-table reads as a *reordering* and needs a manual migration — which the
    // prod deploy refuses (no --delete-data), failing after merge. Order among
    // these trailing columns is free; never wedge one in above `movedAt`.
    running: t.bool().default(false),
    color: t.i32().default(COLOR_UNSET),
    // What the trogg is carrying (GDD "Interacting"): "" = empty-handed, else the
    // kind of the held entity ("boulder"). Picking up deletes the entity's
    // world row and stamps its kind here; putting down clears it and re-inserts the
    // entity. Carryables are fungible (no identity, seeded from the registry); a
    // carried entity's visual variant rides separately in `carryingStyle` while its
    // world row is gone.
    carrying: t.string().default(""),
    // Click-to-move waypoints, serialized as "x,y;x,y;..." and interpreted by
    // shared `projectMotion` (GDD "Movement"). Empty = no path / direct WASD.
    path: t.string().default(""),
    // Chosen avatar body style — an index into `TROGG_STYLES` (GDD "Avatars"), set by
    // `restyle`. Defaults to `STYLE_UNSET` (-1) so an unchosen trogg falls back to its
    // id-derived style, the mirror of `color`.
    style: t.i32().default(STYLE_UNSET),
    equippedMainHand: t.string().default(""),
    equipmentAction: t.string().default(""),
    equipmentActionAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
    equippedMainHandInventoryId: t.u64().default(0n),
    // Standing facing, independent of motion. Defaults to down for existing rows and
    // fresh guests; movement reducers keep it in step with the current heading.
    faceX: t.i32().default(0),
    faceY: t.i32().default(1),
    // Visual variant for carried entities that need one: pickup copies the entity's
    // effective style here, and put-down copies it back.
    carryingStyle: t.string().default(""),
    health: t.i32().default(PLAYER_MAX_HEALTH),
    dead: t.bool().default(false),
    respawnAt: t.option(t.timestamp()).default(undefined),
    // Off-hand slot (e.g. a shield), the mirror of the main-hand fields (GDD "Avatars and
    // equipment"). Appended last so adding it is a non-breaking, auto-migratable column add.
    equippedOffHand: t.string().default(""),
    equippedOffHandInventoryId: t.u64().default(0n),
    // When damage last landed — the out-of-combat clock the regen sweep reads.
    lastDamagedAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
    // Debug cheats (GDD "Commands panel"): a move-speed multiplier, flight
    // (hover + client-side altitude; display only), invulnerability
    // (damagePlayer no-ops), and noclip (the shared projection ignores tile
    // walkability). They ride the synced row like `running`, so every client
    // derives the same motion; written only by `setCheats`.
    cheatSpeed: t.f64().default(1),
    cheatFly: t.bool().default(false),
    cheatInvulnerable: t.bool().default(false),
    cheatNoclip: t.bool().default(false),
    // Flight altitude (GDD "Debug cheats"): like x/y, `z` is the origin of a
    // linear derivation and `dirZ` (-1/0/+1) the vertical intent, written on
    // input transitions (`setLift`) — position over time is derived, never
    // ticked. Grounded rows stay 0/0.
    z: t.f64().default(0),
    dirZ: t.i32().default(0),
    // Earned ember-time (GDD "The fire and the dark" → Presence), stored the
    // way motion is: a value plus the anchor it was true at. Current charge is
    // *derived* (`deriveKindlingCharge`) by applying the accrual rate while
    // online or the decay rate while offline over elapsed real time since the
    // anchor — never advanced on a timer (invariant 1). Bright/ember/dormant
    // are therefore derived state, not stored: bright = online; ember =
    // !online && derived charge > 0; dormant = !online && derived charge <= 0.
    kindlingCharge: t.f64().default(0),
    kindlingChargeAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
  },
);

/**
 * One zone-scoped chat line (GDD "Chat"). Clients subscribe to recent rows in
 * their zone, and a freshly inserted row *is* the live bubble. `name` is
 * denormalised so late joiners render history without a lookup; `rename` rewrites
 * it across the sender's rows so history tracks their current name. Content never
 * leaves the game for analytics (invariant 4).
 */
const chatMessage = table(
  { name: "chat_message", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    sender: t.identity(),
    name: t.string(),
    text: t.string(),
    createdAt: t.timestamp(),
  },
);

/**
 * A zone-scoped cosmetic ghost haunt. A new row is the live fanout event: clients
 * subscribed to the zone render fresh inserts once, while late joiners ignore the
 * replayed snapshot. Rows are capped by `hauntGhost`, so the cosmetic event stream
 * cannot grow without bound.
 */
const ghostHaunt = table(
  { name: "ghost_haunt", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    x: t.i32(),
    y: t.i32(),
    createdAt: t.timestamp(),
  },
);

/**
 * A pending account claim (GDD "Identity" — guest → account upgrade). A guest's
 * browser generates a random `code`, registers it under its own (guest) identity
 * via `startClaim`, then signs in and redeems it as the SpacetimeAuth identity via
 * `redeemClaim`. Binding the code to the guest server-side is what authorises the
 * migration (invariant 3): redeem trusts the code, never a client-asserted guest
 * identity. Private — no client ever reads this table; the code lives only in the
 * browser that minted it. Stale rows expire after `CLAIM_CODE_TTL_MS`.
 */
const claimCode = table(
  { name: "claim_code", public: false },
  {
    code: t.string().primaryKey(),
    guest: t.identity(),
    createdAt: t.timestamp(),
  },
);

/**
 * A boulder (GDD "Boulders"): a mineable rock on an unwalkable tile. Boulders are
 * dynamic obstacles — walkability is the static tilemap minus the tiles boulders
 * sit on — so the same collision that stops a trogg at a wall stops it at a
 * boulder. Seeded per zone from the `ZONES` registry on first connect; a pickaxe
 * mines one into Stone (removing the row), and a trogg can carry or throw one.
 */
const boulder = table(
  { name: "boulder", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    x: t.i32(),
    y: t.i32(),
    // Appended with a default (see the player table's migration note).
    health: t.i32().default(BOULDER_MAX_HEALTH),
    // Which birth cell this rubble plugs (GDD "Onboarding: the Warren");
    // 0 = an ordinary world boulder. Rubble mines exactly like a boulder but
    // is excluded from resets and the spawn cap.
    cellId: t.u32().default(0),
  },
);

/**
 * A tree (GDD "Trees"): choppable scenery on an unwalkable tile, the woodcutting
 * mirror of the boulder — the same dynamic-obstacle collision, seeded per zone
 * from the `ZONES` registry on first connect. An axe fells one into Wood
 * (removing the row). Trees are not carryable: a trunk is not tile-sized.
 */
const tree = table(
  { name: "tree", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    x: t.i32(),
    y: t.i32(),
    // Appended with a default (see the player table's migration note).
    health: t.i32().default(TREE_MAX_HEALTH),
  },
);

/**
 * A hostile inhabitant of the dark and the penumbra (GDD "Dark creatures").
 * Intent-based motion like a player or the retired `hog` row — position is
 * derived with `projectMotion`, never advanced on a timer. `aggroTargetId` is
 * either the identity hex of the trogg it's chasing or "" while wandering.
 * Solid, the same way a Hog used to be: blocks troggs and other dark
 * creatures. Cannot occupy a lit tile (`isLitTile`), which is what keeps it
 * out of claimed ground rather than a targeting rule. `health` at zero is a
 * corpse — settled, inert, reaped by the `regenCreatures` sweep after
 * `NPC_CORPSE_MS`; whether a fresh one then takes its place depends on
 * whether the ground is lit at that moment (Territory and permanence), not
 * anything stored on the row. A region's living population must reach zero
 * before a brazier can go down there (Territory and permanence) — clearing
 * it is what claims the ground, not a separate event.
 */
const darkCreature = table(
  { name: "dark_creature", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    x: t.f64(),
    y: t.f64(),
    dirX: t.i32(),
    dirY: t.i32(),
    movedAt: t.timestamp(),
    species: t.string(),
    health: t.i32(),
    lastDamagedAt: t.timestamp(),
    aggroTargetId: t.string().default(""),
  },
);

/**
 * A pickup item lying on a tile (GDD "Inventory"). It is seeded from the zone
 * registry, then removed by `interact` when a trogg picks it up. Items are not
 * solid; a trogg can stand on a tool, but must face its tile to take it.
 */
const groundItem = table(
  { name: "ground_item", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    item: t.string(),
    x: t.i32(),
    y: t.i32(),
    qty: t.i32().default(1),
  },
);

/**
 * Player inventory (GDD "Inventory"): stackable items merge into one row;
 * non-stackable equippables stay as distinct qty=1 rows. Equipment references an
 * owned row on the player record; it does not remove quantity here.
 */
const inventory = table(
  { name: "inventory", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    playerId: t.identity().index("btree"),
    item: t.string(),
    qty: t.i32(),
  },
);

/**
 * The tribe's one shared resource pool (GDD "The fire and the dark" → The
 * stockpile): one row per item id, fed directly by every gather action —
 * bright or ember — never by a personal inventory. Global, not per-zone: there
 * is only one world. Read-only from a player's perspective; capped at
 * `STOCKPILE_CAP` per item so a long-idle tribe can't bank an indefinite
 * surplus. No index needed at this size.
 */
const stockpile = table(
  { name: "stockpile", public: true },
  {
    item: t.string().primaryKey(),
    qty: t.i32(),
  },
);

/**
 * A fire that holds the dark back from the region it stands in (GDD "The
 * fire and the dark" → Territory and permanence) — a whole region counts as
 * lit the moment its brazier is, not just a radius around it; a region holds
 * at most one non-eternal row. `radius` is cosmetic only now (the visual
 * glow/ground-disc size in `upsertBrazier`), not a gameplay boundary.
 * `isEternal` is true only for the First Fire at the Hearth, which never
 * gutters regardless of upkeep. Every other row can go dark when the
 * stockpile can't cover total upkeep — the region deepest from the Hearth
 * first — and relights for free at any time; the region itself stays
 * claimed the whole time, guttered or not, so nothing needs re-clearing.
 */
const brazier = table(
  { name: "brazier", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    x: t.i32(),
    y: t.i32(),
    radius: t.i32(),
    lit: t.bool(),
    isEternal: t.bool(),
  },
);

/**
 * The brazier upkeep sweep's timer (GDD "The fire and the dark" → Territory
 * and permanence) — a sanctioned scheduled-reducer exception, re-armed only
 * while a player is online.
 */
const brazierUpkeepTimer = table(
  { name: "brazier_upkeep_timer", scheduled: (): any => brazierUpkeep },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  },
);

/**
 * The ember-trogg and dark-creature wander timer (GDD "The fire and the
 * dark" → Presence; "Dark creatures") — the direct successor of the retired
 * `hog_wander`, the same sanctioned scheduled-reducer exception: re-armed
 * only while a player is online, so an empty world does no work. Private (no
 * client reads it). `wanderPresence` is the one reducer bound to it — a
 * SpacetimeDB scheduled table calls exactly one reducer — steering both an
 * ember trogg's instinct amble and a dark creature's wander/aggro/chase.
 */
const emberWanderTimer = table(
  { name: "ember_wander", scheduled: (): any => wanderPresence },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  },
);

/**
 * Live socket presence per trogg (private). A player row is keyed by Identity, so
 * two tabs signed into the same account share one durable trogg. This table tracks
 * the individual connections behind that identity so an extra tab connecting does
 * not restart the trogg's motion, and one tab disconnecting does not mark the shared
 * row offline while another tab is still present.
 */
const playerConnection = table(
  { name: "player_connection", public: false },
  {
    connectionId: t.string().primaryKey(),
    playerId: t.identity().index("btree"),
    connectedAt: t.timestamp(),
  },
);

/**
 * One-shot player respawn timers. Each death inserts one row scheduled for
 * `respawnAt`; the reducer re-checks the player row before respawning so stale
 * timer rows are harmless.
 */
const playerRespawn = table(
  { name: "player_respawn", scheduled: (): any => respawnPlayers },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    playerId: t.identity().index("btree"),
    scheduledAt: t.scheduleAt(),
  },
);

/**
 * One-shot node respawn timers (GDD "Territory claiming"): each breaking hit
 * on a boulder or tree arms one, and the firing re-plants the node in place
 * at full health after `NODE_RESPAWN_MS` — settled ground never runs dry, for
 * bright farming and ember instinct alike.
 */
const nodeRespawn = table(
  { name: "node_respawn", scheduled: (): any => respawnNodes },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    zoneId: t.string(),
    kind: t.string(), // "boulder" | "tree"
    x: t.i32(),
    y: t.i32(),
  },
);

/**
 * The out-of-combat regeneration sweep's timer (GDD "Combat") — a sanctioned
 * scheduled-reducer exception: re-armed only while a player is online, so an
 * empty world does no regen work.
 */
const creatureRegen = table(
  { name: "creature_regen", scheduled: (): any => regenCreatures },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  },
);

/**
 * A claimed region (GDD "Generation: only as far as the light reaches"): the
 * durable truth of how far the tribe's fire has reached. One row per
 * interior region — the Hearth on first connect, then each region a group
 * clears and sets a brazier down in. Penumbra (adjacent, unclaimed) is never
 * stored — derived on demand from this (≤11-row) set plus the committed
 * `WORLD_REGION_ADJACENCY` graph.
 */
const revealedRegion = table(
  { name: "revealed_region", public: true },
  {
    slug: t.string().primaryKey(),
    // The display name, locked the moment the region is first exposed as
    // penumbra — checked unique against every other row, never recomputed
    // (GDD "Generation"). Clients render region names from here, not from
    // the lattice's candidate names.
    name: t.string(),
    // false = penumbra (scouted, unclaimed); true = interior (claimed).
    // A region with no row at all is unreached — a hard collision wall.
    interior: t.bool(),
    revealedAt: t.timestamp(),
  },
);

/**
 * Shared world dials (GDD "Debug cheats") — one public singleton row (id 0).
 * `skyLocked`/`skyPhase` pin the day-night cycle for EVERYONE: the cycle is
 * cosmetic, but the sky is shared fiction, so a Commands-drawer scrub changes
 * every client's sun, not just the scrubber's. Written by `setSky`; clients
 * subscribe and read it in their daylight pass.
 */
const worldState = table(
  { name: "world_state", public: true },
  {
    id: t.u32().primaryKey(),
    skyLocked: t.bool(),
    skyPhase: t.f64(),
  },
);

const spacetimedb = schema({ player, chatMessage, ghostHaunt, claimCode, boulder, tree, darkCreature, groundItem, inventory, stockpile, brazier, brazierUpkeepTimer, emberWanderTimer, playerConnection, playerRespawn, nodeRespawn, creatureRegen, revealedRegion, worldState });
export default spacetimedb;

/** The reducer context, typed against this module's schema (db view + sender). */
export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type ProcCtx = ProcedureCtx<InferSchema<typeof spacetimedb>>;
export type AnalyticsEvent = { distinctId: string; event: string; properties?: Record<string, string | number | boolean> };

/**
 * Out-of-combat regeneration (GDD "Combat"): a trogg untouched for
 * `HEALTH_REGEN_DELAY_MS` heals a fraction of its max per sweep. The sweep
 * re-arms only while a player is online, writes only rows that actually heal, and
 * never revives the dead — respawn does that.
 */
export const regenCreatures = spacetimedb.reducer({ timer: creatureRegen.rowType }, (ctx) => {
  const online = anyPlayerOnline(ctx);
  const now = ctx.timestamp;
  if (online) {
    const rested = (lastDamagedAt: { microsSinceUnixEpoch: bigint } | undefined) =>
      !lastDamagedAt || elapsedMs(lastDamagedAt, now) >= HEALTH_REGEN_DELAY_MS;
    for (const p of ctx.db.player.iter()) {
      if (p.dead || p.health >= PLAYER_MAX_HEALTH || !rested(p.lastDamagedAt)) continue;
      const heal = Math.ceil(PLAYER_MAX_HEALTH * HEALTH_REGEN_FRACTION);
      ctx.db.player.identity.update({ ...p, health: Math.min(PLAYER_MAX_HEALTH, p.health + heal) });
    }

    // Dark creatures: the same out-of-combat heal, plus corpse reaping (GDD
    // "Combat" / "Dark creatures"). A corpse lies for NPC_CORPSE_MS, then this
    // sweep removes it; whether the dark replenishes what was here is decided
    // right here, at the reap, by whether the ground is lit *now* — not
    // frozen at the moment of the kill (Territory and permanence).
    for (const c of ctx.db.darkCreature.iter()) {
      const def = darkCreatureDef(c.species);
      if (c.health <= 0) {
        if (elapsedMs(c.lastDamagedAt, now) < NPC_CORPSE_MS) continue;
        const unlit = !isLitTile(ctx, c.zoneId, Math.round(c.x), Math.round(c.y));
        ctx.db.darkCreature.id.delete(c.id);
        if (unlit) {
          ctx.db.darkCreature.insert({
            id: 0n,
            zoneId: c.zoneId,
            x: c.x,
            y: c.y,
            dirX: 0,
            dirY: 0,
            movedAt: now,
            species: c.species,
            health: def.maxHealth,
            lastDamagedAt: now,
            aggroTargetId: "",
          });
        }
        continue;
      }
      if (c.health >= def.maxHealth || !rested(c.lastDamagedAt)) continue;
      const heal = Math.ceil(def.maxHealth * HEALTH_REGEN_FRACTION);
      ctx.db.darkCreature.id.update({ ...c, health: Math.min(def.maxHealth, c.health + heal) });
    }
  }
  ctx.db.creatureRegen.clear();
  if (online) armRegen(ctx);
});

/** Re-plant a broken node whose one-shot respawn timer has elapsed. If
 *  something now stands on the tile (a trogg, a creature, another node), the
 *  timer re-arms shortly instead of trapping the occupant inside an obstacle. */
export const respawnNodes = spacetimedb.reducer({ timer: nodeRespawn.rowType }, (ctx, { timer }) => {
  ctx.db.nodeRespawn.scheduledId.delete(timer.scheduledId);
  const { zoneId, kind, x, y } = timer;
  const taken =
    boulderAt(ctx, zoneId, x, y) !== undefined ||
    treeAt(ctx, zoneId, x, y) !== undefined ||
    [...ctx.db.player.iter()].some((p) => p.zoneId === zoneId && Math.round(p.x) === x && Math.round(p.y) === y) ||
    [...ctx.db.darkCreature.zoneId.filter(zoneId)].some((c) => c.health > 0 && Math.round(c.x) === x && Math.round(c.y) === y);
  if (taken) {
    const at = ctx.timestamp.microsSinceUnixEpoch + 5_000_000n;
    ctx.db.nodeRespawn.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at), zoneId, kind, x, y });
    return;
  }
  if (kind === "boulder") ctx.db.boulder.insert({ id: 0n, zoneId, x, y, health: BOULDER_MAX_HEALTH, cellId: 0 });
  else ctx.db.tree.insert({ id: 0n, zoneId, x, y, health: TREE_MAX_HEALTH });
});

/** Respawn a dead trogg whose one-shot death timer has elapsed. */
export const respawnPlayers = spacetimedb.reducer({ timer: playerRespawn.rowType }, (ctx, { timer }) => {
  ctx.db.playerRespawn.scheduledId.delete(timer.scheduledId);
  const p = ctx.db.player.identity.find(timer.playerId);
  if (!p || !p.dead) return;
  if (!respawnDue(p, ctx.timestamp)) {
    if (p.respawnAt) scheduleRespawnAt(ctx, p.identity, p.respawnAt);
    return;
  }
  respawnPlayer(ctx, p);
});

/**
 * Brazier upkeep sweep (GDD "The fire and the dark" → Territory and
 * permanence): every lit, non-eternal brazier bills `BRAZIER_UPKEEP_RATE` of
 * `BRAZIER_UPKEEP_ITEM` per tick. When the stockpile can't cover the total,
 * the brazier(s) in the region(s) deepest from the Hearth (by region-graph
 * hop distance, not raw tile distance — regions vary too much in size for
 * that to mean the same thing everywhere) gutter first — never the interior,
 * never at random — until what's left standing is affordable. The First Fire
 * itself is never billed and never gutters.
 */
export const brazierUpkeep = spacetimedb.reducer({ timer: brazierUpkeepTimer.rowType }, (ctx) => {
  const online = anyPlayerOnline(ctx);
  if (online) {
    const depths = regionHopDepths(ctx);
    const rows = [...ctx.db.brazier.iter()];
    const byZone = new Map<string, (typeof rows)[number][]>();
    for (const b of rows) {
      let list = byZone.get(b.zoneId);
      if (!list) {
        list = [];
        byZone.set(b.zoneId, list);
      }
      list.push(b);
    }
    for (const [, zoneBraziers] of byZone) {
      const lit = zoneBraziers
        .filter((b) => b.lit && !b.isEternal)
        .map((b) => ({ row: b, depth: depths.get(regionAt(b.x, b.y).slug) ?? -1 }))
        .sort((a, b2) => b2.depth - a.depth); // deepest (furthest from the Hearth) first
      const stock = ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM)?.qty ?? 0;
      let count = lit.length;
      while (count > 0 && count * BRAZIER_UPKEEP_RATE > stock) {
        const furthest = lit[lit.length - count]!.row;
        ctx.db.brazier.id.update({ ...furthest, lit: false });
        count--;
      }
      if (count > 0) withdrawStockpile(ctx, BRAZIER_UPKEEP_ITEM, count * BRAZIER_UPKEEP_RATE);
    }
  }
  ctx.db.brazierUpkeepTimer.clear();
  if (online) armBrazierUpkeep(ctx);
});

/**
 * The ember-trogg and dark-creature wander sweep (GDD "The fire and the
 * dark" → Presence; "Dark creatures"). Every offline trogg still carrying
 * kindling charge ambles safe interior ground on instinct — confined to lit
 * tiles — and gathers passively from an adjacent boulder or tree at
 * `EMBER_EFFICIENCY_FRACTION` of a bright trogg's rate, with no XP; the
 * instant its charge reaches zero it goes dormant, settled at its zone's
 * nearest hearth. Every living dark creature ambles the dark — confined to
 * *unlit* tiles, the mirror boundary — until a bright trogg comes within
 * `DARK_CREATURE_AGGRO_RANGE`, then turns to close the distance and attacks
 * once in reach; a target that disconnects, dies, or leaves the zone drops
 * the chase. The timer re-arms only while a player is online.
 */
export const wanderPresence = spacetimedb.reducer({ timer: emberWanderTimer.rowType }, (ctx) => {
  const online = anyPlayerOnline(ctx);
  const now = ctx.timestamp;
  if (online) {
    const revealedSlugs = currentRevealedRegions(ctx);
    const penumbraSlugs = penumbraOf(revealedSlugs);
    const revealed = (zone: Zone, x: number, y: number) => isRevealed(zone, revealedSlugs, penumbraSlugs, x, y);
    for (const p of ctx.db.player.iter()) {
      if (p.online) continue; // bright troggs act on player input, not instinct
      const charge = deriveKindlingCharge(p.kindlingCharge, p.kindlingChargeAt, false, now);
      // Instinct never fully sleeps (GDD "Presence"): a charged ember trogg
      // works at the full instinct rate, a dormant one keeps a slower trickle
      // — the world stays busy, and bright play still buys the better rate.
      const gatherFraction = charge > 0 ? EMBER_EFFICIENCY_FRACTION : DORMANT_EFFICIENCY_FRACTION;

      const zone = getZone(p.zoneId);
      if (!zone) continue;
      const blockers = obstacleTiles(ctx, p.zoneId);
      const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)) || !isLitTile(ctx, p.zoneId, x, y) || !revealed(zone, x, y));
      const at = projectMotionState(p, elapsedMs(p.movedAt, now), bounds);
      const cx = Math.round(at.x);
      const cy = Math.round(at.y);

      // Camped beside a node: chip it on a chance per tick, scaled by the same
      // fraction that governs its whole stockpile rate, and stay put — the
      // trogg works the node until it breaks, then seeks the next one.
      const neighbors: Array<[number, number]> = [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ];
      let camped = false;
      for (const [nx, ny] of neighbors) {
        const b = boulderAt(ctx, p.zoneId, nx, ny);
        if (b) {
          camped = true;
          if (ctx.random() < gatherFraction) {
            if (b.health > EMBER_GATHER_DAMAGE) ctx.db.boulder.id.update({ ...b, health: b.health - EMBER_GATHER_DAMAGE });
            else {
              ctx.db.boulder.id.delete(b.id);
              depositStockpile(ctx, "stone", 1);
              scheduleNodeRespawn(ctx, p.zoneId, "boulder", b.x, b.y);
            }
          }
          break;
        }
        const tr = treeAt(ctx, p.zoneId, nx, ny);
        if (tr) {
          camped = true;
          if (ctx.random() < gatherFraction) {
            if (tr.health > EMBER_GATHER_DAMAGE) ctx.db.tree.id.update({ ...tr, health: tr.health - EMBER_GATHER_DAMAGE });
            else {
              ctx.db.tree.id.delete(tr.id);
              depositStockpile(ctx, "wood", 1);
              scheduleNodeRespawn(ctx, p.zoneId, "tree", tr.x, tr.y);
            }
          }
          break;
        }
      }
      if (camped) {
        if (p.dirX !== 0 || p.dirY !== 0 || p.path !== "" || at.x !== p.x || at.y !== p.y)
          ctx.db.player.identity.update({ ...p, x: at.x, y: at.y, dirX: 0, dirY: 0, path: "", movedAt: now });
        continue;
      }

      // En route to a node: the stored path carries it (projection is anchored
      // at the row, so an untouched row keeps gliding). A stall — the mid-hop
      // clamp reports no heading — falls through and re-routes.
      if (p.path !== "" && !at.arrived && (at.dirX !== 0 || at.dirY !== 0)) continue;

      // Seek: route to the nearest node on lit, revealed ground, anywhere in
      // the zone (`EMBER_SEEK_RADIUS` is a routing budget, not a leash). The
      // node tile itself is an obstacle, so `findPath` lands on a walkable
      // tile beside it — the camping spot. A* only runs between nodes.
      const nodes: { x: number; y: number; d: number }[] = [];
      for (const b of ctx.db.boulder.zoneId.filter(p.zoneId)) {
        const d = Math.abs(b.x - cx) + Math.abs(b.y - cy);
        if (d <= EMBER_SEEK_RADIUS) nodes.push({ x: b.x, y: b.y, d });
      }
      for (const tr of ctx.db.tree.zoneId.filter(p.zoneId)) {
        const d = Math.abs(tr.x - cx) + Math.abs(tr.y - cy);
        if (d <= EMBER_SEEK_RADIUS) nodes.push({ x: tr.x, y: tr.y, d });
      }
      nodes.sort((a, b) => a.d - b.d);
      let routed = false;
      for (const node of nodes.slice(0, 4)) {
        const path = smoothPath(bounds, at, findPath(bounds, at, { x: node.x, y: node.y }, EMBER_SEEK_RADIUS));
        const first = path[0];
        if (!first) continue;
        const hopX = first.x - at.x;
        const hopY = first.y - at.y;
        const faceX = Math.abs(hopX) >= Math.abs(hopY) ? Math.sign(hopX) : 0;
        const faceY = Math.abs(hopX) >= Math.abs(hopY) ? 0 : Math.sign(hopY);
        ctx.db.player.identity.update({ ...p, x: at.x, y: at.y, dirX: faceX, dirY: faceY, path: serializePath(path), movedAt: now });
        routed = true;
        break;
      }
      if (routed) continue;

      // Nothing to work: drift the old aimless wander so the settlement still
      // reads as inhabited.
      const moving = p.dirX !== 0 || p.dirY !== 0;
      const aheadClear = moving && footprintWalkable(bounds, at.x + Math.sign(p.dirX), at.y + Math.sign(p.dirY), 1);
      const dir =
        moving && aheadClear && ctx.random() > WANDER_TURN_CHANCE
          ? { dirX: p.dirX, dirY: p.dirY }
          : pickWanderDir(ctx, bounds, { x: cx, y: cy }, 1);
      const unchanged = at.x === p.x && at.y === p.y && dir.dirX === p.dirX && dir.dirY === p.dirY;
      if (unchanged) continue;
      ctx.db.player.identity.update({ ...p, x: at.x, y: at.y, dirX: dir.dirX, dirY: dir.dirY, path: "", movedAt: now });
    }

    // Dark creatures: settle every living one to where its stored intent has
    // carried it and collect the tiles they occupy first (mirroring the
    // retired Hog wander's two-pass shape), so the second pass can keep them
    // off each other's tiles without reading stale positions.
    const staticBlockersByZone = new Map<string, Set<string>>();
    const staticBlockersFor = (zoneId: string): Set<string> => {
      let set = staticBlockersByZone.get(zoneId);
      if (!set) {
        set = obstacleTiles(ctx, zoneId);
        staticBlockersByZone.set(zoneId, set);
      }
      return set;
    };
    const creatureList = [...ctx.db.darkCreature.iter()];
    type CreatureRow = (typeof creatureList)[number];
    const settledCreatures: { row: CreatureRow; x: number; y: number; zoneId: string }[] = [];
    const creatureTilesByZone = new Map<string, Set<string>>();
    for (const c of creatureList) {
      if (c.health <= 0) continue; // corpses lie where they fell
      const zone = getZone(c.zoneId);
      if (!zone) continue;
      const statics = staticBlockersFor(c.zoneId);
      const bounds = zoneBounds(zone, (x, y) => statics.has(tileKey(x, y)) || isLitTile(ctx, c.zoneId, x, y) || !revealed(zone, x, y));
      const at = projectMotionState(c, elapsedMs(c.movedAt, now), bounds);
      settledCreatures.push({ row: c, x: at.x, y: at.y, zoneId: c.zoneId });
      let tiles = creatureTilesByZone.get(c.zoneId);
      if (!tiles) {
        tiles = new Set<string>();
        creatureTilesByZone.set(c.zoneId, tiles);
      }
      tiles.add(tileKey(Math.round(at.x), Math.round(at.y)));
    }

    for (const s of settledCreatures) {
      const c = s.row;
      const zone = getZone(s.zoneId)!;
      const statics = staticBlockersFor(s.zoneId);
      const creatureTiles = creatureTilesByZone.get(s.zoneId)!;
      const ownTile = tileKey(Math.round(s.x), Math.round(s.y));

      // Keep a live target (same zone, online, alive); else look for a fresh
      // bright trogg within aggro range. Sighting is range-based, like earshot.
      let target: NonNullable<ReturnType<typeof ctx.db.player.identity.find>> | undefined;
      for (const pl of ctx.db.player.zoneId.filter(s.zoneId)) {
        if (!pl.online || pl.dead) continue;
        if (c.aggroTargetId && pl.identity.toHexString() === c.aggroTargetId) {
          target = pl;
          break;
        }
      }
      if (!target) {
        for (const pl of ctx.db.player.zoneId.filter(s.zoneId)) {
          if (!pl.online || pl.dead) continue;
          const tp = settle(ctx, pl, now);
          if (Math.hypot(tp.x - s.x, tp.y - s.y) <= DARK_CREATURE_AGGRO_RANGE) {
            target = pl;
            break;
          }
        }
      }
      const aggroTargetId = target ? target.identity.toHexString() : "";

      let dir = { dirX: 0, dirY: 0 };
      if (target) {
        const tp = settle(ctx, target, now);
        const dx = tp.x - s.x;
        const dy = tp.y - s.y;
        const dlen = Math.hypot(dx, dy);
        const toward = dlen > 0 ? { dirX: Math.round((dx / dlen) * DIR_SCALE), dirY: Math.round((dy / dlen) * DIR_SCALE) } : { dirX: 0, dirY: 0 };
        const reach = meleeHit(s.x, s.y, toward.dirX, toward.dirY, { x: tp.x + 0.5, y: tp.y + 0.5, radius: PLAYER_HIT_RADIUS });
        if (reach !== undefined) {
          // Close enough to fight: stop closing (never walks through what it's
          // attacking) and land one hit at this tick's cadence — the same
          // "no twitch checks" slow rhythm as a trogg's own swing (invariant 7).
          const def = darkCreatureDef(c.species);
          damagePlayer(ctx, target, ctx.random.integerInRange(def.damage[0], def.damage[1]));
        } else {
          dir = toward;
        }
      } else {
        const bounds = zoneBounds(zone, (x, y) => {
          const k = tileKey(x, y);
          if (statics.has(k) || isLitTile(ctx, s.zoneId, x, y) || !revealed(zone, x, y)) return true;
          return k !== ownTile && creatureTiles.has(k);
        });
        dir = pickWanderDir(ctx, bounds, { x: Math.round(s.x), y: Math.round(s.y) }, 1);
      }

      const unchanged = s.x === c.x && s.y === c.y && dir.dirX === c.dirX && dir.dirY === c.dirY && aggroTargetId === c.aggroTargetId;
      if (unchanged) continue;
      ctx.db.darkCreature.id.update({ ...c, x: s.x, y: s.y, dirX: dir.dirX, dirY: dir.dirY, movedAt: now, aggroTargetId });
    }
  }
  ctx.db.emberWanderTimer.clear();
  if (online) armEmberWander(ctx);
});
