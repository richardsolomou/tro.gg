import { schema, table, t, type InferSchema, type ProcedureCtx, type ReducerCtx } from "spacetimedb/server";
import { Timestamp } from "spacetimedb";
import {
  COLOR_UNSET,
  elapsedMs,
  STYLE_UNSET,
  HEALTH_REGEN_DELAY_MS,
  HEALTH_REGEN_FRACTION,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  PLAYER_MAX_HEALTH,
} from "../../shared/index";
import {
  anyPlayerOnline,
  armRegen,
  respawnDue,
  scheduleRespawnAt,
  respawnPlayer,
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

const spacetimedb = schema({ player, chatMessage, ghostHaunt, claimCode, boulder, tree, groundItem, inventory, stockpile, playerConnection, playerRespawn, creatureRegen, worldState });
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
  }
  ctx.db.creatureRegen.clear();
  if (online) armRegen(ctx);
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
