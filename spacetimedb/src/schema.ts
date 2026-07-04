import { schema, table, t, type InferSchema, type ProcedureCtx, type ReducerCtx } from "spacetimedb/server";
import { Timestamp } from "spacetimedb";
import {
  COLOR_UNSET,
  elapsedMs,
  isDryFloor,
  footprintTiles,
  getZone,
  hogSize,
  STYLE_UNSET,
  HOG_MAX_HEALTH,
  hogMaxHealth,
  HOG_TURN_CHANCE,
  HEALTH_REGEN_DELAY_MS,
  NPC_CORPSE_MS,
  HEALTH_REGEN_FRACTION,
  footprintWalkable,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  PLAYER_MAX_HEALTH,
  projectMotion,
  tileKey,
  type Zone,
  zoneBounds,
} from "../../shared/index";
import {
  anyPlayerOnline,
  obstacleTiles,
  addPlayerTiles,
  pickWanderDir,
  armWander,
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
 * carries a held Hog's skin while its world row is gone. `style` is the chosen
 * avatar body style. `equippedMainHand` stores the item id currently shown in the
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
    // kind of the held entity ("boulder" | "hog"). Picking up deletes the entity's
    // world row and stamps its kind here; putting down clears it and re-inserts the
    // entity. Boulders/Hogs are fungible (no identity, seeded from the registry);
    // Hog skin rides separately in `carryingStyle` while the world row is gone.
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
    // Visual variant for carried entities that need one. Currently only Hogs use it:
    // pickup copies the Hog row's effective style here, and put-down copies it back.
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
 * An ambient Hog NPC (GDD "Hogs"): a friendly hedgehog that roams the zone on its
 * own. It carries the same intent-based motion as a trogg — an origin (x, y), a
 * cardinal direction, and `movedAt` — so clients derive its position with
 * `projectMotion` and there's no per-frame sync (invariant 2). `health` makes
 * Hogs damageable by the same tile-based combat actions as troggs. Hogs are
 * server-owned (no identity): seeded per zone from the `ZONES` registry on first
 * connect, spawned by the Commands panel, then moved only by the scheduled
 * `wanderHogs` reducer. Merchant/dialogue Hog roles are separate later work.
 *
 * Unlike a trogg, a Hog's origin is an integer tile (`i32`): it ambles tile-to-tile,
 * re-based to each whole tile it reaches (clients still glide between via
 * `projectMotion`), and it never pushes, so it needs no sub-tile precision. The
 * `path`/`homeX`/`homeY` columns are unused by the amble — retained from an earlier
 * home-anchored pathfinding wander, kept only so the shipped schema isn't reordered
 * (columns are appended at the end, never moved — see the migration note above).
 * `style` is usually empty, meaning id-derived variation; explicitly spawned Hogs
 * can store a sprite style so the UI button creates the exact Hog skin clicked.
 * dirX/dirY/movedAt default to idle-at-epoch, path to none.
 */
const hog = table(
  { name: "hog", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    x: t.i32(),
    y: t.i32(),
    dirX: t.i32().default(0),
    dirY: t.i32().default(0),
    movedAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
    path: t.string().default(""),
    // Unused by the tile-by-tile amble; retained from the earlier home-anchored wander
    // (the -1 default is its pre-migration sentinel). Kept only to avoid a column reorder.
    homeX: t.i32().default(-1),
    homeY: t.i32().default(-1),
    // Explicit hedgehog style (GDD "Hogs"): "" = a common roamer whose skin the client
    // derives from the id; "buff"/"dino" = a 2×2 showpiece; "chicken" = the easter egg.
    // The server reads `hogSize(style)` for the footprint, so the style alone carries the
    // size. Appended last per the migration note on the player table.
    style: t.string().default(""),
    health: t.i32().default(HOG_MAX_HEALTH),
    // When damage last landed — the out-of-combat clock the regen sweep reads.
    lastDamagedAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
    // A thrown Hog is in flight until this time: the wander leaves it at rest so
    // it doesn't walk off before the client's arc lands it. Epoch (the default)
    // = grounded — an ordinary roamer, a put-down, or a seeded Hog. Appended last
    // per the migration note on the player table.
    landingAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
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
 * The Hog wander timer (GDD "Hogs"). A scheduled table is SpacetimeDB's
 * deterministic timer — the only way state changes outside player input (invariant
 * 1: no simulation tick). Each tick fires `wanderHogs`, which re-bases every Hog to
 * the tile it reached and picks its next heading, then re-arms this timer *only while
 * a player is online*, so an empty zone settles its Hogs to rest and then does no
 * further work (invariant 1).
 */
const hogWander = table(
  { name: "hog_wander", scheduled: (): any => wanderHogs },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
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
 * The out-of-combat regeneration sweep's timer (GDD "Combat") — the same
 * sanctioned scheduled-reducer exception as `hog_wander`: re-armed only while a
 * player is online, so an empty world does no regen work.
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

const spacetimedb = schema({ player, chatMessage, ghostHaunt, claimCode, boulder, tree, hog, groundItem, inventory, playerConnection, hogWander, playerRespawn, creatureRegen, worldState });
export default spacetimedb;

/** The reducer context, typed against this module's schema (db view + sender). */
export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type ProcCtx = ProcedureCtx<InferSchema<typeof spacetimedb>>;
export type AnalyticsEvent = { distinctId: string; event: string; properties?: Record<string, string | number | boolean> };

/**
 * The Hog wander tick (GDD "Hogs"), fired once per tile-crossing. Settle each Hog to
 * the tile it's on now — flush against everything solid: walls, boulders, troggs, and
 * other Hogs — then give it a heading for the next tile. Because the tick fires every
 * tile, a Hog only ever commits to one tile at a time and stops dead in front of a
 * trogg (or anything) instead of gliding through it; and a Hog freed from a block
 * never banks more than a tile of travel. A moving Hog keeps its heading unless that
 * tile is now blocked or a `HOG_TURN_CHANCE` roll turns it; a fresh heading idles with
 * `HOG_IDLE_CHANCE` so Hogs pause. Troggs block Hogs, but troggs never block each
 * other (GDD "Hogs"). Randomness is the context RNG, seeded from the tick's timestamp,
 * so the schedule replays deterministically (invariant 3). The timer re-arms only
 * while a player is online: with the zone empty, every Hog is left at rest and the
 * timer stops, so an empty zone does no further work (invariant 1).
 */
export const wanderHogs = spacetimedb.reducer({ timer: hogWander.rowType }, (ctx) => {
  const online = anyPlayerOnline(ctx);
  const now = ctx.timestamp;

  // Per-zone obstacles every Hog must avoid: boulders, trees + troggs. Memoised across
  // Hogs in the same zone; each Hog's own tile and the other Hogs' tiles are layered on in pass 2.
  const blockersByZone = new Map<string, Set<string>>();
  const blockersFor = (zoneId: string): Set<string> => {
    let set = blockersByZone.get(zoneId);
    if (!set) {
      set = obstacleTiles(ctx, zoneId);
      addPlayerTiles(ctx, zoneId, now, set);
      blockersByZone.set(zoneId, set);
    }
    return set;
  };

  // Pass 1: project every Hog to where its stored intent has carried it. A run in
  // progress is a single intent gliding from an old origin (fluid, any of the 8
  // directions) — rows re-base only when a run ends, so a straight run costs no
  // writes at all. The rounded tile registers the footprint other Hogs collide with.
  const hogList = [...ctx.db.hog.iter()];
  type HogRow = (typeof hogList)[number];
  const settled: { hog: HogRow; px: number; py: number; x: number; y: number; size: number; zone: Zone; blockers: Set<string> }[] = [];
  const hogTilesByZone = new Map<string, Set<string>>();
  for (const h of hogList) {
    const zone = getZone(h.zoneId);
    if (!zone) continue;
    if (h.health <= 0) continue; // corpses lie where they fell
    if (h.landingAt && elapsedMs(h.landingAt, now) < 0) continue; // a thrown Hog waits at rest until it lands
    const size = hogSize(h.style);
    const blockers = blockersFor(h.zoneId);
    // Hogs keep to dry ground: water blocks them like a boulder does (GDD "Zones").
    const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)) || !isDryFloor(zone, x, y));
    const pos = projectMotion({ ...h, size }, elapsedMs(h.movedAt, now), bounds);
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    settled.push({ hog: h, px: pos.x, py: pos.y, x, y, size, zone, blockers });
    let tiles = hogTilesByZone.get(h.zoneId);
    if (!tiles) {
      tiles = new Set<string>();
      hogTilesByZone.set(h.zoneId, tiles);
    }
    for (const tile of footprintTiles(x, y, size)) tiles.add(tileKey(tile.x, tile.y));
  }

  // Pass 2: decide each Hog's run. A moving Hog claims the footprint one step ahead
  // every tick (the per-tick `claimed` set keeps two Hogs off the same tile — GDD:
  // Hogs never overlap) and keeps gliding write-free unless that step is blocked or
  // a HOG_TURN_CHANCE roll ends the run; then it settles to its tile and picks a
  // fresh 8-way heading (or idles). While the zone is empty, everything settles to rest.
  const claimedByZone = new Map<string, Set<string>>();
  for (const s of settled) {
    const hogTiles = hogTilesByZone.get(s.hog.zoneId)!;
    let claimed = claimedByZone.get(s.hog.zoneId);
    if (!claimed) {
      claimed = new Set<string>();
      claimedByZone.set(s.hog.zoneId, claimed);
    }
    // A Hog's own footprint is excepted, so its next step — which overlaps where it
    // stands (more so for a 2×2) — isn't read as blocked by itself.
    const own = new Set(footprintTiles(s.x, s.y, s.size).map((t) => tileKey(t.x, t.y)));
    const bounds = zoneBounds(s.zone, (x, y) => {
      const k = tileKey(x, y);
      if (!isDryFloor(s.zone, x, y)) return true;
      return !own.has(k) && (s.blockers.has(k) || hogTiles.has(k) || claimed!.has(k));
    });
    const moving = s.hog.dirX !== 0 || s.hog.dirY !== 0;

    if (online && moving) {
      const stepX = Math.sign(s.hog.dirX);
      const stepY = Math.sign(s.hog.dirY);
      const aheadClear = footprintWalkable(bounds, s.x + stepX, s.y + stepY, s.size);
      if (aheadClear && ctx.random() > HOG_TURN_CHANCE) {
        // the run continues: claim the step so nobody else takes it, write nothing
        for (const t of footprintTiles(s.x + stepX, s.y + stepY, s.size)) claimed.add(tileKey(t.x, t.y));
        continue;
      }
    }

    const dir = online ? pickWanderDir(ctx, bounds, { x: s.x, y: s.y }, s.size) : { dirX: 0, dirY: 0 };
    if (dir.dirX !== 0 || dir.dirY !== 0) {
      for (const t of footprintTiles(s.x + dir.dirX, s.y + dir.dirY, s.size)) claimed.add(tileKey(t.x, t.y));
    }

    // Skip the write when nothing changed — a resting Hog that re-rolls idle, or any
    // Hog once the zone has emptied — so an idle world produces no diffs (invariant 1).
    const unchanged = s.x === s.hog.x && s.y === s.hog.y && dir.dirX === s.hog.dirX && dir.dirY === s.hog.dirY && s.hog.path === "";
    if (unchanged) continue;
    ctx.db.hog.id.update({ ...s.hog, x: s.x, y: s.y, dirX: dir.dirX, dirY: dir.dirY, path: "", movedAt: now });
  }

  // Clear first so exactly one timer is pending regardless of whether the firing
  // row was auto-deleted, then re-arm only while someone is watching.
  ctx.db.hogWander.clear();
  if (online) armWander(ctx);
});

/**
 * Out-of-combat regeneration (GDD "Combat"): any creature untouched for
 * `HEALTH_REGEN_DELAY_MS` heals a fraction of its max per sweep. The sweep
 * re-arms only while a player is online (the `wanderHogs` pattern), writes only
 * rows that actually heal, and never revives the dead — respawn does that.
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
    for (const h of ctx.db.hog.iter()) {
      if (h.health <= 0) {
        // a corpse never heals; it lies for NPC_CORPSE_MS, then the sweep reaps it
        if (elapsedMs(h.lastDamagedAt, now) >= NPC_CORPSE_MS) ctx.db.hog.id.delete(h.id);
        continue;
      }
      const max = hogMaxHealth(h.style);
      if (h.health >= max || !rested(h.lastDamagedAt)) continue;
      ctx.db.hog.id.update({ ...h, health: Math.min(max, h.health + Math.ceil(max * HEALTH_REGEN_FRACTION)) });
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
