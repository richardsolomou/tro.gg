import { schema, table, t, type InferSchema, type ProcedureCtx, type ReducerCtx } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  CHAT_HISTORY_MAX,
  CHAT_MAX_CHARS,
  CHAT_RATE_LIMIT_MS,
  CLAIM_CODE_TTL_MS,
  COLOR_UNSET,
  CARDINALS,
  elapsedMs,
  facingTile,
  findPath,
  footprintTiles,
  getZone,
  GHOST_HAUNT_HISTORY_MAX,
  HOG_IDLE_CHANCE,
  hogStyleFor,
  HOG_STEP_INTERVAL_MS,
  HOG_TURN_CHANCE,
  INVENTORY_SLOT_COUNT,
  hogSize,
  isColorIndex,
  isEquippableItem,
  isGeneratedName,
  isHogStyle,
  isItemId,
  isSpawnableItemId,
  isStackableItem,
  isTroggStyleIndex,
  STYLE_UNSET,
  isValidName,
  isWalkable,
  HOG_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  MAX_GROUND_ITEMS_PER_ZONE,
  MAX_HOGS_PER_ZONE,
  PLAYER_MAX_HEALTH,
  PLAYER_RESPAWN_MS,
  projectMotion,
  serializePath,
  snapToTile,
  SPACETIMEAUTH_ISSUER,
  spawnTile,
  spawnTiles,
  STARTING_ZONE_SLUG,
  SWORD_DAMAGE,
  THROWN_OBJECT_DAMAGE,
  THROWN_OBJECT_RANGE,
  type Stamp,
  tileKey,
  TROGG_STYLES,
  walkableCardinals,
  type Zone,
  type ZoneBounds,
  zoneBounds,
} from "../../shared/index";

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
 * A pushable boulder (GDD "Pushing"): a rock on an unwalkable tile that a trogg
 * can shove one tile at a time. Boulders are dynamic obstacles — walkability is
 * the static tilemap minus the tiles boulders sit on — so the same collision that
 * stops a trogg at a wall stops it at a boulder. Seeded per zone from the `ZONES`
 * registry on first connect; moved only by the `push` reducer.
 */
const boulder = table(
  { name: "boulder", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zoneId: t.string().index("btree"),
    x: t.i32(),
    y: t.i32(),
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

const spacetimedb = schema({ player, chatMessage, ghostHaunt, claimCode, boulder, hog, groundItem, inventory, playerConnection, hogWander, playerRespawn });
export default spacetimedb;

/** The reducer context, typed against this module's schema (db view + sender). */
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type ProcCtx = ProcedureCtx<InferSchema<typeof spacetimedb>>;
type AnalyticsEvent = { distinctId: string; event: string; properties?: Record<string, string | number | boolean> };

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";

export const init = spacetimedb.init(() => {});

function captureProcedureEvents(ctx: ProcCtx, posthogKey: string, events: AnalyticsEvent | AnalyticsEvent[] | undefined): void {
  const key = posthogKey.trim();
  if (!key) return;
  const batch = Array.isArray(events) ? events : events ? [events] : [];
  for (const item of batch) {
    try {
      ctx.http.fetch(POSTHOG_CAPTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          event: item.event,
          distinct_id: item.distinctId,
          properties: {
            ...item.properties,
            source: item.properties?.source ?? "spacetimedb-procedure",
          },
        }),
      });
    } catch {
      // Telemetry is best-effort and must never roll back an accepted gameplay action.
    }
  }
}

function sourceProp(source: string): Record<string, string> {
  const trimmed = source.trim();
  return trimmed ? { source: trimmed.slice(0, 64) } : {};
}

function distinctId(ctx: Ctx): string {
  return ctx.sender.toHexString();
}

function unit(): {} {
  return {};
}

/**
 * A client connected. Resume the existing trogg (mark it online) or spawn a fresh
 * one at the zone centre. The durable row already is the player — there is no
 * separate load step.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  // init runs first-publish only, so it can't seed a table added to an already-published
  // module; seed lazily on connect, idempotently.
  const startingZone = getZone(STARTING_ZONE_SLUG)!;
  seedBoulders(ctx, startingZone);
  seedHogs(ctx, startingZone);
  seedGroundItems(ctx, startingZone);
  // A player is here, so make sure the Hogs are roaming (no-op if already armed).
  armWander(ctx);

  const hadLiveConnection = playerConnectionCount(ctx, ctx.sender) > 0;
  rememberPlayerConnection(ctx);

  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    // The same account can have several live sockets (two tabs, or two devices).
    // They all control and observe one trogg row. Only the first live connection
    // should resume/reset presence; later connections must not stop an in-flight
    // movement intent that the already-active tab is driving.
    if (existing.online && hadLiveConnection) return;

    // A returning trogg is already settled (disconnect zeroes its direction), but
    // a tilemap edit could leave its resting tile inside a new wall; nudge it back
    // to spawn so it never resumes embedded in an obstacle (invariant 6).
    const zone = getZone(existing.zoneId);
    const stuck = zone && !isWalkable(zone, Math.round(existing.x), Math.round(existing.y));
    const pos = stuck ? spawnAt(zone) : { x: existing.x, y: existing.y };
    ctx.db.player.identity.update({ ...existing, x: pos.x, y: pos.y, dirX: 0, dirY: 0, running: false, path: "", online: true, movedAt: ctx.timestamp });
    return;
  }

  // A connection authenticated by a SpacetimeAuth OIDC token is an account, not a
  // guest (its identity is stable across browsers/devices). Any other token —
  // including SpacetimeDB's own self-issued anonymous one — is a guest.
  const isAccount = isSpacetimeAuthCaller(ctx);

  const zone = getZone(STARTING_ZONE_SLUG)!;
  const at = spawnAt(zone);
  // Identity hex starts with a fixed `c200` tag, so name from the variable tail.
  const hex = ctx.sender.toHexString();
  const generated = `trogg-${hex.slice(-4)}`;
  // Seed an account with its provider username when it's valid and free; fall
  // back to a generated name (a fresh-device sign-in then needs no rename to play).
  const name = isAccount ? (claimProviderName(ctx) ?? generated) : generated;

  ctx.db.player.insert({
    identity: ctx.sender,
    name,
    isGuest: !isAccount,
    zoneId: zone.slug,
    x: at.x,
    y: at.y,
    dirX: 0,
    dirY: 0,
    running: false,
    movedAt: ctx.timestamp,
    online: true,
    lastChatAt: undefined,
    color: COLOR_UNSET,
    carrying: "",
    carryingStyle: "",
    path: "",
    style: STYLE_UNSET,
    faceX: 0,
    faceY: 1,
    equippedMainHand: "",
    equipmentAction: "",
    equipmentActionAt: Timestamp.UNIX_EPOCH,
    equippedMainHandInventoryId: 0n,
    health: PLAYER_MAX_HEALTH,
    dead: false,
    respawnAt: undefined,
  });
});

/** A fresh trogg's spawn tile: the zone centre (a walkable interior tile). */
function spawnAt(zone: Zone): { x: number; y: number } {
  return { x: Math.floor(zone.width / 2), y: Math.floor(zone.height / 2) };
}

/** Seed a zone's boulders from the registry, unless it already has some. */
function seedBoulders(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.boulder.zoneId.filter(zone.slug)].length > 0) return;
  for (const b of zone.boulders) {
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: b.x, y: b.y });
  }
}

/** Seed a zone's Hogs from the registry, unless it already has some — the common
 *  roamers (style "" → client-derived skin) and the rare 2×2 showpieces (explicit
 *  style, so `hogSize` makes them big). */
function seedHogs(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.hog.zoneId.filter(zone.slug)].length > 0) return;
  for (const h of zone.hogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: "", health: HOG_MAX_HEALTH });
  }
  for (const h of zone.bigHogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: h.style, health: HOG_MAX_HEALTH });
  }
}

/** Seed a zone's starter pickup items from the registry, unless it already has some. */
function seedGroundItems(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.groundItem.zoneId.filter(zone.slug)].length > 0) return;
  for (const item of zone.items) {
    ctx.db.groundItem.insert({ id: 0n, zoneId: zone.slug, item: item.item, x: item.x, y: item.y, qty: 1 });
  }
}

/**
 * A client disconnected. Settle the trogg to where it is *now* and mark it
 * offline (clients subscribe to online players only, so it leaves their view
 * without losing durable progress).
 */
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (forgetPlayerConnection(ctx) > 0) return;

  const settled = settle(ctx, p, ctx.timestamp);
  // Drop whatever the trogg was carrying where it stops, so a carried entity is
  // never orphaned while its carrier is offline (GDD "Interacting"). If it's boxed
  // in and can't be placed, keep it on the row — it's durable and still droppable
  // when the trogg returns.
  let carrying = p.carrying;
  let carryingStyle = p.carryingStyle;
  if (carrying !== "") {
    const zone = getZone(p.zoneId);
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    const face = facingDir(p);
    if (zone && placeCarried(ctx, zone, carrying, carryingStyle, occupied, settled.x, settled.y, face.dirX, face.dirY)) {
      carrying = "";
      carryingStyle = "";
    }
  }
  ctx.db.player.identity.update({ ...p, x: settled.x, y: settled.y, dirX: 0, dirY: 0, running: false, path: "", online: false, carrying, carryingStyle });
});

/**
 * A WASD direction intent (GDD "Movement"). Movement is 4-directional — one
 * cardinal axis at a time, no diagonals (like Pokémon/Zelda). Settle the origin
 * to where the trogg is now (so elapsed travel under the old direction — and the
 * old speed — isn't lost or replayed), then store the new direction, `running`,
 * and timestamp. `running` (shift held) rides the intent so all clients derive the
 * same faster speed (GDD "Movement"). Non-idle movement also updates the synced
 * standing facing, so stopping preserves the heading other clients just saw.
 * Position is never ticked (invariant 1). A
 * diagonal intent is rejected, not coerced (invariant 3 — never trust the client):
 * the trogg holds its prior motion.
 */
export const move = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32(), running: t.bool() }, (ctx, { dirX, dirY, running }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const dir = cardinal(dirX, dirY);
  if (!dir) return;
  const settled = settle(ctx, p, ctx.timestamp);
  ctx.db.player.identity.update({
    ...p,
    x: settled.x,
    y: settled.y,
    dirX: dir.dirX,
    dirY: dir.dirY,
    running,
    path: "",
    faceX: dir.dirX === 0 && dir.dirY === 0 ? p.faceX : dir.dirX,
    faceY: dir.dirX === 0 && dir.dirY === 0 ? p.faceY : dir.dirY,
    movedAt: ctx.timestamp,
  });
});

/**
 * A standing turn (GDD "Movement" tap-to-turn). Facing is input-driven like movement:
 * the client sends it only on a direction transition, never per frame. The reducer
 * settles and stops current motion before storing the facing, so a forged mid-walk
 * `face` call can't make the trogg glide sideways (invariant 3).
 */
export const face = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32() }, (ctx, { dirX, dirY }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const dir = cardinal(dirX, dirY);
  if (!dir || (dir.dirX === 0 && dir.dirY === 0)) return;
  const settled = settle(ctx, p, ctx.timestamp);
  ctx.db.player.identity.update({
    ...p,
    x: settled.x,
    y: settled.y,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    faceX: dir.dirX,
    faceY: dir.dirY,
    movedAt: ctx.timestamp,
  });
});

/**
 * Click-to-move (GDD "Movement"). The server computes the route over the zone's
 * walkable tiles plus current boulder occupancy, stores the path as the synced
 * motion intent, and every client derives animation from that row. If the clicked
 * tile is blocked, `findPath` routes to the nearest reachable cardinal neighbour.
 */
export const moveTo = spacetimedb.reducer({ x: t.i32(), y: t.i32(), running: t.bool() }, (ctx, target) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;

  const blockers = troggBlockers(ctx, p.zoneId, ctx.timestamp);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  const start = settle(ctx, p, ctx.timestamp);
  const path = findPath(bounds, start, { x: target.x, y: target.y });
  const first = path[0];

  ctx.db.player.identity.update({
    ...p,
    x: start.x,
    y: start.y,
    dirX: first ? first.x - start.x : 0,
    dirY: first ? first.y - start.y : 0,
    running: target.running,
    path: serializePath(path),
    faceX: first ? first.x - start.x : p.faceX,
    faceY: first ? first.y - start.y : p.faceY,
    movedAt: ctx.timestamp,
  });
});

/**
 * Push the boulder a trogg is walking into (GDD "Pushing"). The client fires this
 * when its avatar lines up flush against a boulder; the server re-derives the
 * trogg's position authoritatively (invariant 3), and only shifts the boulder one
 * tile if the trogg is squarely facing it and the tile beyond is open floor. The
 * trogg's motion is re-based to the flush tile, so the boulder advances no faster
 * than the trogg can walk — there's no server tick (invariant 1), and spamming the
 * reducer can't help: after a push the boulder sits a tile away and isn't faced
 * again until the trogg physically catches up.
 */
export const push = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;

  const blockers = troggBlockers(ctx, p.zoneId, ctx.timestamp);
  const pos = projectMotion(p, elapsedMs(p.movedAt, ctx.timestamp), zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y))));

  const ahead = facingTile(pos.x, pos.y, p.dirX, p.dirY);
  if (!ahead) return; // not squarely facing a tile

  const b = boulderAt(ctx, p.zoneId, ahead.x, ahead.y);
  if (!b) return; // nothing to push (a Hog in the way is flush-blocking, not pushable)

  const dest = { x: ahead.x + Math.sign(p.dirX), y: ahead.y + Math.sign(p.dirY) };
  if (!isWalkable(zone, dest.x, dest.y) || blockers.has(tileKey(dest.x, dest.y))) return; // wall, boulder, or Hog

  // `facingTile` already proved the trogg is on a tile centre; re-base its motion
  // to that whole tile so the grid-lock holds (GDD "Movement").
  const flush = snapToTile(pos);
  ctx.db.boulder.id.update({ ...b, x: dest.x, y: dest.y });
  ctx.db.player.identity.update({ ...p, x: flush.x, y: flush.y, movedAt: ctx.timestamp });
});

/**
 * Interact with nearby things (GDD "Interacting") — a generic action key (client
 * `E`). Empty-handed, pick up an adjacent ground item into inventory or lift an
 * adjacent boulder / hog onto the trogg (delete its world row, stamp `carrying`);
 * already carrying, set it back down on the faced tile. The faced direction is
 * passed in because an idle trogg's standing facing isn't synced (GDD "Movement");
 * the server still re-derives the trogg's tile and only acts on adjacent targets,
 * preferring the faced tile when there are multiple candidates, so the client can't
 * reach past its neighbours (invariant 3).
 */
function runInteract(ctx: Ctx, { dirX, dirY, source = "" }: { dirX: number; dirY: number; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (p.dead) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];

  const dir = cardinal(dirX, dirY);
  const pos = settle(ctx, p, ctx.timestamp);
  const props = { zone: p.zoneId, ...sourceProp(source) };

  if (p.carrying !== "") {
    // Put down: place the held entity on the faced tile, or the nearest free
    // neighbour (spawnTile). A boxed-in trogg can't drop, so it keeps carrying.
    const kind = p.carrying;
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    const place = placeCarried(ctx, zone, p.carrying, p.carryingStyle, occupied, pos.x, pos.y, dir?.dirX ?? 0, dir?.dirY ?? 0);
    if (place) ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
    if (!place) return [];
    const properties: Record<string, string | number | boolean> = { ...props, kind };
    if (kind === "hog" && p.carryingStyle !== "") properties.style = p.carryingStyle;
    return [{ distinctId: distinctId(ctx), event: "object_dropped", properties }];
  }

  const target = pickupTarget(ctx, p.zoneId, Math.round(pos.x), Math.round(pos.y), dir, ctx.timestamp);
  if (target?.kind === "item") {
    if (!isItemId(target.row.item)) return [];
    const qty = target.row.qty ?? 1;
    if (!addInventory(ctx, p.identity, target.row.item, qty)) return [];
    ctx.db.groundItem.id.delete(target.row.id);
    return [{ distinctId: distinctId(ctx), event: "inventory_item_acquired", properties: { ...props, item: target.row.item, qty } }];
  }
  if (target?.kind === "boulder") {
    ctx.db.boulder.id.delete(target.row.id);
    ctx.db.player.identity.update({ ...p, carrying: "boulder", carryingStyle: "" });
    return [{ distinctId: distinctId(ctx), event: "object_picked_up", properties: { ...props, kind: "boulder" } }];
  }
  if (target?.kind === "hog") {
    const carryingStyle = effectiveHogStyle(target.row);
    ctx.db.hog.id.delete(target.row.id);
    ctx.db.player.identity.update({ ...p, carrying: "hog", carryingStyle });
    return [{ distinctId: distinctId(ctx), event: "object_picked_up", properties: { ...props, kind: "hog", style: carryingStyle } }];
  }
  return [];
}

export const interact = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32() }, (ctx, args) => {
  runInteract(ctx, args);
});

export const interactAction = spacetimedb.procedure(
  { dirX: t.i32(), dirY: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runInteract(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

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

  // Per-zone obstacles every Hog must avoid: boulders + troggs. Memoised across Hogs in
  // the same zone; each Hog's own tile and the other Hogs' tiles are layered on in pass 2.
  const blockersByZone = new Map<string, Set<string>>();
  const blockersFor = (zoneId: string): Set<string> => {
    let set = blockersByZone.get(zoneId);
    if (!set) {
      set = boulderTiles(ctx, zoneId);
      addPlayerTiles(ctx, zoneId, now, set);
      blockersByZone.set(zoneId, set);
    }
    return set;
  };

  // Pass 1: settle every Hog to the tile it's on now, so the tiles other Hogs settle
  // onto are known before any heading is picked (Hogs are solid to each other). A Hog
  // re-bases each tile, so its stored intent is at most one tile old.
  const hogList = [...ctx.db.hog.iter()];
  type HogRow = (typeof hogList)[number];
  const settled: { hog: HogRow; x: number; y: number; size: number; zone: Zone; blockers: Set<string> }[] = [];
  const hogTilesByZone = new Map<string, Set<string>>();
  for (const h of hogList) {
    const zone = getZone(h.zoneId);
    if (!zone) continue;
    const size = hogSize(h.style);
    const blockers = blockersFor(h.zoneId);
    const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
    // Round the in-between position (the footprint's top-left) to the tile it ended on:
    // a Hog steps tile-to-tile over walkable floor, so rounding stays on walkable floor.
    const pos = projectMotion({ ...h, size }, elapsedMs(h.movedAt, now), bounds);
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    settled.push({ hog: h, x, y, size, zone, blockers });
    let tiles = hogTilesByZone.get(h.zoneId);
    if (!tiles) {
      tiles = new Set<string>();
      hogTilesByZone.set(h.zoneId, tiles);
    }
    for (const tile of footprintTiles(x, y, size)) tiles.add(tileKey(tile.x, tile.y));
  }

  // Pass 2: pick each Hog's heading against walls, boulders, troggs, the other Hogs'
  // settled tiles, and the tiles Hogs earlier this tick have *claimed* to step onto — its
  // own tile excepted, so it isn't blocked by itself. Pass 1's settled set keeps two Hogs
  // from resting on the same tile; the per-tick `claimed` set keeps two from heading onto
  // the same empty tile (GDD: two Hogs never share a tile). While the zone is empty, rest.
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
      return !own.has(k) && (s.blockers.has(k) || hogTiles.has(k) || claimed!.has(k));
    });
    const dir = online ? pickWanderDir(ctx, bounds, s.hog, { x: s.x, y: s.y }, s.size) : { dirX: 0, dirY: 0 };
    // Claim the whole footprint the Hog steps into, so no other Hog this tick heads
    // onto any tile of it (GDD: Hogs never overlap).
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
 * Spawn one thing at the caller's location from the pre-alpha Commands panel
 * (optionally gated client-side by `spawn-command`). The server re-derives the
 * trogg's tile authoritatively (invariant 3) and places the thing on a nearby free
 * tile, starting with the tile it faces, so nothing lands inside a wall or on
 * another entity. Refused once the zone is at its cap, so a scripted client can't
 * flood it (the client flag only gates the UI). An unknown kind/item, a full zone,
 * or a boxed-in trogg is a silent no-op.
 */
function runSpawn(ctx: Ctx, { kind, item = "", source = "" }: { kind: string; item?: string; source?: string }): AnalyticsEvent[] {
  if (kind !== "boulder" && kind !== "hog" && kind !== "item") return [];
  if (kind === "boulder" && item !== "") return [];
  if (kind === "item" && !isSpawnableItemId(item)) return [];
  if (kind === "hog" && item !== "" && !isHogStyle(item)) return [];

  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (p.dead) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];

  const existing =
    kind === "boulder"
      ? countRows(ctx.db.boulder.zoneId.filter(p.zoneId))
      : kind === "hog"
        ? countRows(ctx.db.hog.zoneId.filter(p.zoneId))
        : countRows(ctx.db.groundItem.zoneId.filter(p.zoneId));
  const cap = kind === "boulder" ? MAX_BOULDERS_PER_ZONE : kind === "hog" ? MAX_HOGS_PER_ZONE : MAX_GROUND_ITEMS_PER_ZONE;
  if (existing >= cap) return [];

  // Drop entities on free floor — never inside a wall or on top of anything solid
  // (a boulder, a Hog, or another trogg) or another pickup item.
  const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  addGroundItemTiles(ctx, p.zoneId, occupied);
  const pos = settle(ctx, p, ctx.timestamp);
  const face = facingDir(p);
  const tile = spawnTile(zone, (x, y) => occupied.has(tileKey(x, y)), pos.x, pos.y, face.dirX, face.dirY);
  if (!tile) return [];

  if (kind === "boulder") {
    ctx.db.boulder.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y });
  } else if (kind === "hog") {
    // A spawned Hog starts at rest and joins the roamers — the next wander tick
    // gives it a heading like any other. `item` carries an explicit sprite style.
    ctx.db.hog.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: tile.x, homeY: tile.y, style: item, health: HOG_MAX_HEALTH });
  } else {
    ctx.db.groundItem.insert({ id: 0n, zoneId: p.zoneId, item, x: tile.x, y: tile.y, qty: 1 });
  }

  const properties: Record<string, string | number | boolean> = { zone: p.zoneId, kind, count: 1, ...sourceProp(source) };
  if (kind === "item") properties.item = item;
  if (kind === "hog" && item !== "") properties.style = item;
  return [{ distinctId: distinctId(ctx), event: "debug_entity_spawned", properties }];
}

export const spawn = spacetimedb.reducer({ kind: t.string(), item: t.string() }, (ctx, args) => {
  runSpawn(ctx, args);
});

export const spawnAction = spacetimedb.procedure(
  { kind: t.string(), item: t.string(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runSpawn(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Reset the caller's zone boulders to their `ZONES` registry positions (GDD
 * "Pushing"). Clears the zone's boulders and reseeds from the registry — the single
 * source of truth — so a layout shoved out of shape snaps back. Fired by the Commands
 * panel; open like every reducer, with the optional `boulder-reset` flag gating the
 * client control.
 */
function runResetBoulders(ctx: Ctx, source = ""): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];
  for (const b of [...ctx.db.boulder.zoneId.filter(zone.slug)]) ctx.db.boulder.id.delete(b.id);
  seedBoulders(ctx, zone);
  return [{ distinctId: distinctId(ctx), event: "boulders_reset", properties: { zone: zone.slug, ...sourceProp(source) } }];
}

export const resetBoulders = spacetimedb.reducer((ctx) => {
  runResetBoulders(ctx);
});

export const resetBouldersAction = spacetimedb.procedure(
  { posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runResetBoulders(tx, args.source));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Reset the caller's zone Hogs to their `ZONES` registry population (GDD "Hogs").
 * Clears the zone's Hogs and reseeds from the registry — the single source of
 * truth — so a zone overrun with extra panel-spawned Hogs snaps back to its intended
 * count. The mirror of `resetBoulders`. A Hog a trogg is carrying lives on the
 * player row, not the `hog` table, so it survives the cull and re-materialises on
 * put-down (GDD "Interacting"). Fired by the Commands panel; open like every reducer,
 * with the optional `hog-reset` flag gating the client control.
 */
function runResetHogs(ctx: Ctx, source = ""): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];
  for (const h of [...ctx.db.hog.zoneId.filter(zone.slug)]) ctx.db.hog.id.delete(h.id);
  seedHogs(ctx, zone);
  return [{ distinctId: distinctId(ctx), event: "hedgehogs_reset", properties: { zone: zone.slug, ...sourceProp(source) } }];
}

export const resetHogs = spacetimedb.reducer((ctx) => {
  runResetHogs(ctx);
});

export const resetHogsAction = spacetimedb.procedure(
  { posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runResetHogs(tx, args.source));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * A zone-scoped chat line. Validate length, enforce the per-player rate limit
 * (invariant 3 — never trust the client), append the row, and trim the zone's
 * history to its cap.
 */
function runChat(ctx: Ctx, { text, source = "" }: { text: string; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];

  const trimmed = text.trim().slice(0, CHAT_MAX_CHARS);
  if (!trimmed) return [];

  if (p.lastChatAt && elapsedMs(p.lastChatAt, ctx.timestamp) < CHAT_RATE_LIMIT_MS) return [];
  ctx.db.player.identity.update({ ...p, lastChatAt: ctx.timestamp });

  ctx.db.chatMessage.insert({
    id: 0n,
    zoneId: p.zoneId,
    sender: ctx.sender,
    name: p.name,
    text: trimmed,
    createdAt: ctx.timestamp,
  });

  // Cap the zone's history. We trim on every insert, so the backlog is over by at most
  // one — drop the single oldest row (lowest auto-inc id) in a single pass, rather than
  // materializing and sorting the whole zone history on each message.
  let count = 0;
  let oldest: bigint | undefined;
  for (const line of ctx.db.chatMessage.zoneId.filter(p.zoneId)) {
    count++;
    if (oldest === undefined || line.id < oldest) oldest = line.id;
  }
  if (count > CHAT_HISTORY_MAX && oldest !== undefined) ctx.db.chatMessage.id.delete(oldest);
  return [{ distinctId: distinctId(ctx), event: "chat_sent", properties: { zone: p.zoneId, ...sourceProp(source) } }];
}

export const chat = spacetimedb.reducer({ text: t.string() }, (ctx, args) => {
  runChat(ctx, args);
});

export const chatAction = spacetimedb.procedure(
  { text: t.string(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runChat(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Flicker a cosmetic ghost in the caller's zone. The server chooses a random walkable
 * tile and inserts a zone-scoped event row so every live subscriber in the map sees
 * the same haunt. It has no collision or durable gameplay effect.
 */
function runHauntGhostOnce(ctx: Ctx): string | undefined {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || !p.online) return undefined;
  const zone = getZone(p.zoneId);
  if (!zone) return undefined;

  const tile = randomWalkableTile(ctx, zone);
  if (!tile) return undefined;

  ctx.db.ghostHaunt.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, createdAt: ctx.timestamp });
  trimGhostHaunts(ctx, p.zoneId);
  return p.zoneId;
}

function runHauntGhost(ctx: Ctx, { count = 1, source = "" }: { count?: number; source?: string } = {}): AnalyticsEvent[] {
  const wanted = Number.isSafeInteger(count) ? Math.max(1, Math.min(12, Math.floor(count))) : 1;
  let zone: string | undefined;
  let inserted = 0;
  for (let i = 0; i < wanted; i++) {
    const nextZone = runHauntGhostOnce(ctx);
    if (!nextZone) continue;
    zone = nextZone;
    inserted++;
  }
  if (!zone || inserted === 0) return [];
  return [{ distinctId: distinctId(ctx), event: "ghost_summoned", properties: { zone, count: inserted, ...sourceProp(source) } }];
}

export const hauntGhost = spacetimedb.reducer((ctx) => {
  runHauntGhost(ctx);
});

export const hauntGhostAction = spacetimedb.procedure(
  { count: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runHauntGhost(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Rename the caller's trogg (GDD "Identity": names are unique, 3–20 chars,
 * alphanumeric + hyphen). This is how a player swaps the generated `trogg-####`
 * for one they choose. Validation and the uniqueness scan run server-side
 * (invariant 3); an invalid or taken name is a silent no-op, like a rejected chat
 * line, and the client sees its name simply not change. The denormalised name on
 * the player's past chat lines is rewritten too, so history shows their current
 * name rather than whatever they were called when each line was sent.
 */
function runRename(ctx: Ctx, { name, source = "" }: { name: string; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];

  const trimmed = name.trim();
  if (trimmed === p.name || !isValidName(trimmed) || nameTaken(ctx, trimmed, ctx.sender)) return [];

  ctx.db.player.identity.update({ ...p, name: trimmed });
  for (const line of ctx.db.chatMessage.iter()) {
    if (line.sender.isEqual(ctx.sender)) ctx.db.chatMessage.id.update({ ...line, name: trimmed });
  }
  return [{ distinctId: distinctId(ctx), event: "trogg_renamed", properties: { zone: p.zoneId, ...sourceProp(source) } }];
}

export const rename = spacetimedb.reducer({ name: t.string() }, (ctx, args) => {
  runRename(ctx, args);
});

export const renameAction = spacetimedb.procedure(
  { name: t.string(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runRename(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Recolour the caller's trogg (GDD "Avatars and equipment"): store a chosen index
 * into the shared `TROGG_COLORS` palette, replacing the id-derived default. The
 * index is validated server-side (invariant 3); an out-of-range index or one
 * already set is a silent no-op, like `rename`. The colour rides the zone player
 * sync, so the tint updates for everyone; chat name colour is derived from the
 * same row, so no denormalised copy needs rewriting.
 */
function runRecolor(ctx: Ctx, { color, source = "" }: { color: number; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (color === p.color || !isColorIndex(color)) return [];
  ctx.db.player.identity.update({ ...p, color });
  return [{ distinctId: distinctId(ctx), event: "trogg_recolored", properties: { color, ...sourceProp(source) } }];
}

export const recolor = spacetimedb.reducer({ color: t.i32() }, (ctx, args) => {
  runRecolor(ctx, args);
});

export const recolorAction = spacetimedb.procedure(
  { color: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runRecolor(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Restyle the caller's trogg (GDD "Avatars and equipment"): store a chosen index
 * into the shared `TROGG_STYLES` list, replacing the id-derived default. The mirror
 * of `recolor` on the other appearance axis (shape, not tint). The index is
 * validated server-side (invariant 3); an out-of-range index or one already set is
 * a silent no-op. The style rides the zone player sync, so the sprite swaps for
 * everyone.
 */
function runRestyle(ctx: Ctx, { style, source = "" }: { style: number; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (style === p.style || !isTroggStyleIndex(style)) return [];
  ctx.db.player.identity.update({ ...p, style });
  return [{ distinctId: distinctId(ctx), event: "trogg_restyled", properties: { style: TROGG_STYLES[style] ?? String(style), ...sourceProp(source) } }];
}

export const restyle = spacetimedb.reducer({ style: t.i32() }, (ctx, args) => {
  runRestyle(ctx, args);
});

export const restyleAction = spacetimedb.procedure(
  { style: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runRestyle(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Equip an owned item in the main hand (GDD "Inventory"). Equipment references a
 * specific inventory row; it does not consume or move the item. `0` unequips.
 * The reducer validates ownership and slot server-side.
 */
function runEquipItem(ctx: Ctx, { inventoryId, source = "" }: { inventoryId: bigint; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];

  if (inventoryId === 0n) {
    if (p.equippedMainHand !== "" || p.equippedMainHandInventoryId !== 0n) {
      ctx.db.player.identity.update({ ...p, equippedMainHand: "", equippedMainHandInventoryId: 0n });
      return [
        {
          distinctId: distinctId(ctx),
          event: "item_equipped",
          properties: { zone: p.zoneId, item: p.equippedMainHand, equipped: false, ...sourceProp(source) },
        },
      ];
    }
    return [];
  }

  const row = ownedInventoryRow(ctx, p.identity, inventoryId);
  if (!row || row.qty <= 0 || !isEquippableItem(row.item)) return [];
  if (p.equippedMainHandInventoryId === row.id) return [];
  ctx.db.player.identity.update({ ...p, equippedMainHand: row.item, equippedMainHandInventoryId: row.id });
  return [{ distinctId: distinctId(ctx), event: "item_equipped", properties: { zone: p.zoneId, item: row.item, equipped: true, ...sourceProp(source) } }];
}

export const equipItem = spacetimedb.reducer({ inventoryId: t.u64() }, (ctx, args) => {
  runEquipItem(ctx, args);
});

export const equipItemAction = spacetimedb.procedure(
  { inventoryId: t.u64(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runEquipItem(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Drop one unit of an owned inventory item back into the world (GDD "Inventory") as
 * a `ground_item` anyone can pick up. Placement mirrors carried put-down and debug
 * spawns: the faced tile, else the nearest free neighbour, else the trogg's own tile
 * (`spawnTile`), honouring `MAX_GROUND_ITEMS_PER_ZONE`. If the zone is at its ceiling
 * or every candidate tile is blocked the drop is refused and nothing is removed, so
 * the item is never lost. Removing the equipped row unequips it.
 */
function runDropItem(ctx: Ctx, { inventoryId, source = "" }: { inventoryId: bigint; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const row = ownedInventoryRow(ctx, p.identity, inventoryId);
  if (!row || row.qty <= 0) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];
  if (countRows(ctx.db.groundItem.zoneId.filter(p.zoneId)) >= MAX_GROUND_ITEMS_PER_ZONE) return [];

  const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  addGroundItemTiles(ctx, p.zoneId, occupied);
  const pos = settle(ctx, p, ctx.timestamp);
  const face = facingDir(p);
  const tile = spawnTile(zone, (x, y) => occupied.has(tileKey(x, y)), pos.x, pos.y, face.dirX, face.dirY);
  if (!tile) return [];

  const removed = removeInventoryUnit(ctx, p.identity, inventoryId);
  if (!removed) return [];
  if (removed.removedLastUnit && p.equippedMainHandInventoryId === inventoryId) {
    ctx.db.player.identity.update({ ...p, equippedMainHand: "", equippedMainHandInventoryId: 0n });
  }
  ctx.db.groundItem.insert({ id: 0n, zoneId: p.zoneId, item: removed.item, x: tile.x, y: tile.y, qty: 1 });
  return [{ distinctId: distinctId(ctx), event: "inventory_item_dropped", properties: { zone: p.zoneId, item: removed.item, ...sourceProp(source) } }];
}

export const dropItem = spacetimedb.reducer({ inventoryId: t.u64() }, (ctx, args) => {
  runDropItem(ctx, args);
});

export const dropItemAction = spacetimedb.procedure(
  { inventoryId: t.u64(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runDropItem(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Permanently destroy one unit of an owned inventory item (GDD "Inventory") — no
 * `ground_item` is created. Removing the equipped row unequips it.
 */
function runDiscardItem(ctx: Ctx, { inventoryId, source = "" }: { inventoryId: bigint; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const removed = removeInventoryUnit(ctx, p.identity, inventoryId);
  if (!removed) return [];
  if (removed.removedLastUnit && p.equippedMainHandInventoryId === inventoryId) {
    ctx.db.player.identity.update({ ...p, equippedMainHand: "", equippedMainHandInventoryId: 0n });
  }
  return [{ distinctId: distinctId(ctx), event: "inventory_item_discarded", properties: { zone: p.zoneId, item: removed.item, ...sourceProp(source) } }];
}

export const discardItem = spacetimedb.reducer({ inventoryId: t.u64() }, (ctx, args) => {
  runDiscardItem(ctx, args);
});

export const discardItemAction = spacetimedb.procedure(
  { inventoryId: t.u64(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runDiscardItem(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Use the equipped main-hand item (GDD "Avatars and equipment"). The row update
 * is a visible, low-volume impulse every client can animate. It preserves the
 * current movement intent — using a tool never turns into a stop. If the trogg is
 * carrying a boulder or Hog, `F` throws it as a tile-based impact weapon. Otherwise
 * pickaxes mine the faced boulder into one Stone inventory item, and swords damage
 * the faced adjacent online trogg or Hog; at zero health the target dies.
 */
function runUseEquipped(ctx: Ctx, { dirX, dirY, source = "" }: { dirX: number; dirY: number; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (p.dead) return [];
  const dir = cardinal(dirX, dirY);
  if (!dir || (dir.dirX === 0 && dir.dirY === 0)) return [];

  const zone = getZone(p.zoneId);
  if (!zone) return [];
  const pos = settle(ctx, p, ctx.timestamp);
  const props = { zone: p.zoneId, ...sourceProp(source) };
  const events: AnalyticsEvent[] = [];

  if (p.carrying !== "") {
    const thrown = throwCarried(ctx, p, zone, pos, dir);
    if (!thrown) return [];
    const throwProps: Record<string, string | number | boolean> = { ...props, kind: thrown.kind, range: thrown.range };
    if (thrown.hitTarget) throwProps.hit_target = thrown.hitTarget;
    events.push({ distinctId: distinctId(ctx), event: "object_thrown", properties: throwProps });
    if (thrown.hitTarget && thrown.damage) {
      events.push({
        distinctId: distinctId(ctx),
        event: "combat_hit",
        properties: { ...props, weapon: `thrown_${thrown.kind}`, target: thrown.hitTarget, damage: thrown.damage, killed: thrown.killed },
      });
    }
    if (thrown.playerDeath) events.push(playerDiedEvent(thrown.playerDeath.distinctId, props, `thrown_${thrown.kind}`, thrown.playerDeath));
    return events;
  }

  const equipped = equippedInventoryRow(ctx, p);
  if (!equipped) return [];

  if (equipped.item === "pickaxe") {
    const ax = Math.round(pos.x) + dir.dirX;
    const ay = Math.round(pos.y) + dir.dirY;
    const b = boulderAt(ctx, p.zoneId, ax, ay);
    if (b) {
      if (addInventory(ctx, p.identity, "stone", 1)) {
        ctx.db.boulder.id.delete(b.id);
        events.push({ distinctId: distinctId(ctx), event: "inventory_item_acquired", properties: { zone: p.zoneId, item: "stone", qty: 1, ...sourceProp(source) } });
      }
    }
  } else if (equipped.item === "sword") {
    const ax = Math.round(pos.x) + dir.dirX;
    const ay = Math.round(pos.y) + dir.dirY;
    const target = playerAt(ctx, p.zoneId, ax, ay, ctx.timestamp, p.identity);
    if (target) {
      const result = damagePlayer(ctx, target, SWORD_DAMAGE);
      events.push({ distinctId: distinctId(ctx), event: "combat_hit", properties: { ...props, weapon: "sword", target: "trogg", damage: SWORD_DAMAGE, killed: result.killed } });
      if (result.killed) events.push(playerDiedEvent(target.identity.toHexString(), props, "sword", result));
    } else {
      const h = hogAt(ctx, p.zoneId, ax, ay, ctx.timestamp);
      if (h) {
        const result = damageHog(ctx, h, SWORD_DAMAGE);
        events.push({ distinctId: distinctId(ctx), event: "combat_hit", properties: { ...props, weapon: "sword", target: "hog", damage: SWORD_DAMAGE, killed: result.killed } });
      }
    }
  }

  ctx.db.player.identity.update({
    ...p,
    equippedMainHand: equipped.item,
    equippedMainHandInventoryId: equipped.id,
    equipmentAction: equipped.item,
    equipmentActionAt: ctx.timestamp,
  });
  events.unshift({ distinctId: distinctId(ctx), event: "equipped_item_used", properties: { zone: p.zoneId, item: equipped.item, ...sourceProp(source) } });
  return events;
}

export const useEquipped = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32() }, (ctx, args) => {
  runUseEquipped(ctx, args);
});

/** Manual compatibility hook: respawn only when the death timer is already due. */
export const respawn = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || !p.dead) return;
  if (!respawnDue(p, ctx.timestamp)) return;
  for (const timer of [...ctx.db.playerRespawn.playerId.filter(p.identity)]) ctx.db.playerRespawn.scheduledId.delete(timer.scheduledId);
  respawnPlayer(ctx, p);
});

export const useEquippedAction = spacetimedb.procedure(
  { dirX: t.i32(), dirY: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runUseEquipped(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/** A claim nonce is a v4 UUID minted by the client (`crypto.randomUUID`). */
const CLAIM_CODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step 1 of the guest → account upgrade (GDD "Identity"). Called while connected
 * as a guest: register the browser-minted nonce under the guest's own identity so
 * a later `redeemClaim` can authorise migrating this trogg. Only a guest with a
 * live trogg may start a claim; any previous pending code for this guest is
 * replaced so only the latest attempt is redeemable.
 */
export const startClaim = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || !p.isGuest) return;
  if (!CLAIM_CODE_RE.test(code)) return; // client mints a UUID (crypto.randomUUID); reject anything else

  for (const existing of ctx.db.claimCode.iter()) {
    if (existing.guest.isEqual(ctx.sender)) ctx.db.claimCode.code.delete(existing.code);
  }
  ctx.db.claimCode.insert({ code, guest: ctx.sender, createdAt: ctx.timestamp });
});

/**
 * Step 2 of the guest → account upgrade. Called after signing in, now connected
 * as the SpacetimeAuth identity. Trust only a real SpacetimeAuth caller (invariant
 * 3) and a fresh, matching nonce; then fold the guest trogg into this account: the
 * guest's chosen name carries over (unless this account already chose one), and
 * the guest row is removed so the world shows one trogg. The account row itself was
 * created by `clientConnected` on this connection (or already existed on return).
 */
export const redeemClaim = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  if (!isSpacetimeAuthCaller(ctx)) return;

  const pending = ctx.db.claimCode.code.find(code);
  if (!pending) return;
  // Always consume the nonce, even if it's stale or the guest is gone.
  ctx.db.claimCode.code.delete(code);
  if (elapsedMs(pending.createdAt, ctx.timestamp) > CLAIM_CODE_TTL_MS) return;

  const guest = ctx.db.player.identity.find(pending.guest);
  const account = ctx.db.player.identity.find(ctx.sender);
  if (!guest || !account || guest.identity.isEqual(account.identity)) return;

  // Fold the guest's carried entity into the account too — it exists only as the guest
  // row's `carrying` (its world row was deleted on pickup), so deleting the guest without
  // this would destroy it (GDD "Interacting": nothing is orphaned). If the account is
  // already carrying, drop the guest's into the world where it stood instead.
  let carrying = account.carrying;
  let carryingStyle = account.carryingStyle;
  if (guest.carrying !== "") {
    if (carrying === "") {
      carrying = guest.carrying;
      carryingStyle = guest.carryingStyle;
    } else {
      const zone = getZone(guest.zoneId);
      const occupied = solidTiles(ctx, guest.zoneId, ctx.timestamp, guest.identity);
      const face = facingDir(guest);
      if (zone) placeCarried(ctx, zone, guest.carrying, guest.carryingStyle, occupied, guest.x, guest.y, face.dirX, face.dirY);
    }
  }

  // Remove the guest row before checking name availability, so the name it's handing over
  // isn't counted as taken by the guest itself — otherwise a guest that renamed before
  // signing up could never carry that chosen name onto its account.
  const guestName = guest.name;
  ctx.db.player.identity.delete(guest.identity);

  // Carry the guest's chosen name onto a freshly-named account (never clobber a
  // returning account's own name), staying within the uniqueness rule.
  const inheritName = !isGeneratedName(guestName) && isGeneratedName(account.name) && !nameTaken(ctx, guestName, ctx.sender);
  const movedInventoryIds = moveInventory(ctx, guest.identity, account.identity);
  const accountEquipped = equippedInventoryRow(ctx, account);
  const guestEquippedId = movedInventoryIds.get(guest.equippedMainHandInventoryId) ?? 0n;
  const guestEquipped = guestEquippedId !== 0n ? ownedInventoryRow(ctx, account.identity, guestEquippedId) : undefined;
  const equippedMainHand = accountEquipped?.item ?? guestEquipped?.item ?? "";
  const equippedMainHandInventoryId = accountEquipped?.id ?? guestEquipped?.id ?? 0n;
  ctx.db.player.identity.update({
    ...account,
    name: inheritName ? guestName : account.name,
    carrying,
    carryingStyle,
    equippedMainHand,
    equippedMainHandInventoryId,
    isGuest: false,
  });
});

/** Whether any player is currently online — the Hogs only roam while someone is
 *  watching (invariant 1: an empty zone does no work). */
function anyPlayerOnline(ctx: Ctx): boolean {
  for (const p of ctx.db.player.iter()) if (p.online) return true;
  return false;
}

function playerConnectionCount(ctx: Ctx, playerId: Ctx["sender"]): number {
  return countRows(ctx.db.playerConnection.playerId.filter(playerId));
}

function rememberPlayerConnection(ctx: Ctx): void {
  if (!ctx.connectionId) return;
  const connectionId = ctx.connectionId.toHexString();
  if (ctx.db.playerConnection.connectionId.find(connectionId)) return;
  ctx.db.playerConnection.insert({ connectionId, playerId: ctx.sender, connectedAt: ctx.timestamp });
}

function forgetPlayerConnection(ctx: Ctx): number {
  if (ctx.connectionId) ctx.db.playerConnection.connectionId.delete(ctx.connectionId.toHexString());
  return playerConnectionCount(ctx, ctx.sender);
}

/** Pick a walkable floor tile from a zone. Used for the cosmetic ghost haunt. */
function randomWalkableTile(ctx: Ctx, zone: Zone): { x: number; y: number } | undefined {
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y < zone.height; y++) {
    for (let x = 0; x < zone.width; x++) {
      if (isWalkable(zone, x, y)) tiles.push({ x, y });
    }
  }
  if (tiles.length === 0) return undefined;
  return tiles[ctx.random.integerInRange(0, tiles.length - 1)];
}

/** Cap old ghost event rows for a zone; haunts are only useful as fresh inserts. */
function trimGhostHaunts(ctx: Ctx, zoneId: string): void {
  const rows = [...ctx.db.ghostHaunt.zoneId.filter(zoneId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const excess = rows.length - GHOST_HAUNT_HISTORY_MAX;
  for (let i = 0; i < excess; i++) ctx.db.ghostHaunt.id.delete(rows[i]!.id);
}

/** Arm a single one-shot Hog wander tick, unless one is already pending. The tick
 *  fires once per tile-crossing so a Hog re-bases (and re-checks collision) every tile
 *  (GDD "Hogs"). */
function armWander(ctx: Ctx): void {
  if (ctx.db.hogWander.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(Math.round(HOG_STEP_INTERVAL_MS)) * 1000n;
  ctx.db.hogWander.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

/**
 * A Hog's heading for the next tile (GDD "Hogs"). A Hog ambling in a direction keeps
 * going so long as that tile is open and a `HOG_TURN_CHANCE` roll doesn't turn it — so
 * it walks in gentle runs rather than jittering every tile. Otherwise (blocked ahead,
 * or it turned, or it was idle) it picks fresh: idle with `HOG_IDLE_CHANCE` so it
 * pauses, else a random walkable cardinal. `bounds` already treats walls, boulders,
 * troggs, and other Hogs as unwalkable, so a picked tile is always clear.
 */
function pickWanderDir(
  ctx: Ctx,
  bounds: ZoneBounds,
  hog: { dirX: number; dirY: number },
  pos: { x: number; y: number },
  size: number,
): { dirX: number; dirY: number } {
  const options = walkableCardinals(bounds, pos.x, pos.y, size);
  const ahead = options.find((d) => d.dirX === hog.dirX && d.dirY === hog.dirY);
  if (ahead && ctx.random() > HOG_TURN_CHANCE) return ahead;
  if (ctx.random() < HOG_IDLE_CHANCE) return { dirX: 0, dirY: 0 };
  if (options.length === 0) return { dirX: 0, dirY: 0 };
  return options[ctx.random.integerInRange(0, options.length - 1)]!;
}

/** Whether the caller authenticated with a SpacetimeAuth OIDC token (an account, not a guest). */
function isSpacetimeAuthCaller(ctx: Ctx): boolean {
  return ctx.senderAuth.hasJWT && ctx.senderAuth.jwt?.issuer === SPACETIMEAUTH_ISSUER;
}

/** A valid, free name from the caller's OIDC username claims, or undefined. */
function claimProviderName(ctx: Ctx): string | undefined {
  const payload = ctx.senderAuth.jwt?.fullPayload ?? {};
  const candidate = payload["preferred_username"] ?? payload["name"];
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return isValidName(trimmed) && !nameTaken(ctx, trimmed, ctx.sender) ? trimmed : undefined;
}

/** Whether another player already holds `name` (case-insensitive). */
function nameTaken(ctx: Ctx, name: string, self: Ctx["sender"]): boolean {
  const lower = name.toLowerCase();
  for (const other of ctx.db.player.iter()) {
    if (!self.isEqual(other.identity) && other.name.toLowerCase() === lower) return true;
  }
  return false;
}

/** The motion-bearing slice of a player row that `settle` derives position from. */
type Settleable = { x: number; y: number; dirX: number; dirY: number; running: boolean; path?: string; zoneId: string; movedAt: Stamp };

/**
 * Derive the trogg's position at `now` from its stored motion intent, colliding
 * against everything solid to a trogg — walls, boulders, and Hogs — so it settles
 * flush against an obstacle, never inside one, then snap it to a whole tile:
 * movement is grid-locked (GDD "Movement"), so a stored origin is always a tile
 * centre. Troggs do *not* collide with each other (GDD "Hogs"), so other players
 * are absent here. The client only sends `move` when the trogg is tile-aligned, so
 * the snap is a no-op in the normal case and a guard against a misbehaving client
 * in the rest (invariant 3).
 */
function settle(ctx: Ctx, p: Settleable, now: Stamp): { x: number; y: number } {
  const zone = getZone(p.zoneId);
  if (!zone) return { x: p.x, y: p.y };
  const blockers = troggBlockers(ctx, p.zoneId, now);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  return snapToTile(projectMotion(p, elapsedMs(p.movedAt, now), bounds));
}

/** Count rows in a table iterable without materializing an array. */
function countRows(rows: Iterable<unknown>): number {
  let n = 0;
  for (const _ of rows) n++;
  return n;
}

/** The set of tiles occupied by boulders in a zone, keyed by `tileKey`. */
function boulderTiles(ctx: Ctx, zoneId: string): Set<string> {
  const tiles = new Set<string>();
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) tiles.add(tileKey(b.x, b.y));
  return tiles;
}

/** The tiles solid to a trogg in a zone: boulders + Hogs (GDD "Hogs"). Not other
 *  troggs — trogg↔trogg has no collision. Hogs re-base every tile, so their stored
 *  intent is at most one tile old; projecting against walls + boulders puts each Hog
 *  within a tile of its real spot, enough to block a trogg flush. */
function troggBlockers(ctx: Ctx, zoneId: string, now: Stamp): Set<string> {
  const tiles = boulderTiles(ctx, zoneId);
  addHogTiles(ctx, zoneId, now, tiles);
  return tiles;
}

/** Add each Hog's current footprint (projected to `now`, against walls + boulders) to
 *  `set` — one tile for a common Hog, the whole 2×2 for a big one (GDD "Hogs"). */
function addHogTiles(ctx: Ctx, zoneId: string, now: Stamp, set: Set<string>): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  const boulders = boulderTiles(ctx, zoneId);
  const bounds = zoneBounds(zone, (x, y) => boulders.has(tileKey(x, y)));
  for (const h of ctx.db.hog.zoneId.filter(zoneId)) {
    const size = hogSize(h.style);
    const pos = projectMotion({ ...h, size }, elapsedMs(h.movedAt, now), bounds);
    for (const tile of footprintTiles(Math.round(pos.x), Math.round(pos.y), size)) set.add(tileKey(tile.x, tile.y));
  }
}

/** Add each online trogg's current tile (projected to `now`, against walls + boulders
 *  + Hogs) to `set`, skipping `exclude` (a trogg never blocks itself). Lets Hogs and
 *  dropped objects avoid the tiles troggs stand on. */
function addPlayerTiles(ctx: Ctx, zoneId: string, now: Stamp, set: Set<string>, exclude?: Ctx["sender"]): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  const blockers = troggBlockers(ctx, zoneId, now);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  for (const p of ctx.db.player.zoneId.filter(zoneId)) {
    if (!p.online) continue;
    if (exclude && p.identity.isEqual(exclude)) continue;
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    set.add(tileKey(Math.round(pos.x), Math.round(pos.y)));
  }
}

/** Every solid tile a freshly placed entity must avoid — boulders, Hogs, and other
 *  troggs — so a spawn or drop never lands on top of something. `exclude` skips the
 *  acting trogg's own tile, leaving it as a last-resort fallback when boxed in. */
function solidTiles(ctx: Ctx, zoneId: string, now: Stamp, exclude?: Ctx["sender"]): Set<string> {
  const tiles = boulderTiles(ctx, zoneId);
  addHogTiles(ctx, zoneId, now, tiles);
  addPlayerTiles(ctx, zoneId, now, tiles, exclude);
  return tiles;
}

/** Mark existing pickup items as visually occupied for new debug spawns. */
function addGroundItemTiles(ctx: Ctx, zoneId: string, set: Set<string>): void {
  for (const item of ctx.db.groundItem.zoneId.filter(zoneId)) set.add(tileKey(item.x, item.y));
}

/** The boulder at a tile in a zone, or undefined. */
function boulderAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) {
    if (b.x === x && b.y === y) return b;
  }
  return undefined;
}

/** The pickup item at a tile in a zone, or undefined. */
function groundItemAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const item of ctx.db.groundItem.zoneId.filter(zoneId)) {
    if (item.x === x && item.y === y) return item;
  }
  return undefined;
}

/** The player's owned inventory row by id, or undefined. */
function ownedInventoryRow(ctx: Ctx, playerId: Ctx["sender"], id: bigint) {
  const row = ctx.db.inventory.id.find(id);
  return row && row.playerId.isEqual(playerId) ? row : undefined;
}

/** The specific inventory row currently equipped, with a fallback for pre-row-id rows. */
function equippedInventoryRow(ctx: Ctx, p: { identity: Ctx["sender"]; equippedMainHand: string; equippedMainHandInventoryId: bigint }) {
  const byId = p.equippedMainHandInventoryId !== 0n ? ownedInventoryRow(ctx, p.identity, p.equippedMainHandInventoryId) : undefined;
  if (byId && byId.qty > 0 && isEquippableItem(byId.item)) return byId;

  if (!isEquippableItem(p.equippedMainHand)) return undefined;
  for (const row of ctx.db.inventory.playerId.filter(p.identity)) {
    if (row.item === p.equippedMainHand && row.qty > 0) return row;
  }
  return undefined;
}

/**
 * Remove one unit of an owned inventory row: decrement a stack, or delete a qty=1
 * row outright. Returns the item id and whether the row's last unit was removed (so
 * the caller can unequip when the equipped row is gone), or undefined if the row
 * isn't owned or is already empty.
 */
function removeInventoryUnit(ctx: Ctx, playerId: Ctx["sender"], inventoryId: bigint): { item: string; removedLastUnit: boolean } | undefined {
  const row = ownedInventoryRow(ctx, playerId, inventoryId);
  if (!row || row.qty <= 0) return undefined;
  if (row.qty > 1) {
    ctx.db.inventory.id.update({ ...row, qty: row.qty - 1 });
    return { item: row.item, removedLastUnit: false };
  }
  ctx.db.inventory.id.delete(row.id);
  return { item: row.item, removedLastUnit: true };
}

/** Add an item to inventory. Stackable items merge; new rows require a free carry slot. */
function addInventory(ctx: Ctx, playerId: Ctx["sender"], item: string, qty: number): boolean {
  if (!isItemId(item) || qty <= 0) return false;
  if (isStackableItem(item)) {
    for (const row of ctx.db.inventory.playerId.filter(playerId)) {
      if (row.item === item) {
        ctx.db.inventory.id.update({ ...row, qty: row.qty + qty });
        return true;
      }
    }
    if (!hasFreeInventorySlot(ctx, playerId)) return false;
    ctx.db.inventory.insert({ id: 0n, playerId, item, qty });
    return true;
  }

  if (inventorySlotCount(ctx, playerId) + qty > INVENTORY_SLOT_COUNT) return false;
  for (let i = 0; i < qty; i++) {
    ctx.db.inventory.insert({ id: 0n, playerId, item, qty: 1 });
  }
  return true;
}

function inventorySlotCount(ctx: Ctx, playerId: Ctx["sender"]): number {
  let count = 0;
  for (const _row of ctx.db.inventory.playerId.filter(playerId)) count++;
  return count;
}

function hasFreeInventorySlot(ctx: Ctx, playerId: Ctx["sender"]): boolean {
  return inventorySlotCount(ctx, playerId) < INVENTORY_SLOT_COUNT;
}

/** Fold every inventory row from one identity into another, preserving item counts. */
function moveInventory(ctx: Ctx, from: Ctx["sender"], to: Ctx["sender"]): Map<bigint, bigint> {
  const moved = new Map<bigint, bigint>();
  for (const row of [...ctx.db.inventory.playerId.filter(from)]) {
    if (isStackableItem(row.item)) {
      moved.set(row.id, mergeInventoryForClaim(ctx, to, row.item, row.qty));
    } else {
      const inserted = ctx.db.inventory.insert({ id: 0n, playerId: to, item: row.item, qty: 1 });
      moved.set(row.id, inserted.id);
    }
    ctx.db.inventory.id.delete(row.id);
  }
  return moved;
}

function mergeInventoryForClaim(ctx: Ctx, playerId: Ctx["sender"], item: string, qty: number): bigint {
  for (const row of ctx.db.inventory.playerId.filter(playerId)) {
    if (row.item === item) {
      ctx.db.inventory.id.update({ ...row, qty: row.qty + qty });
      return row.id;
    }
  }
  return ctx.db.inventory.insert({ id: 0n, playerId, item, qty }).id;
}

/**
 * The Hog currently on a tile in a zone, or undefined. Unlike a boulder a Hog is
 * in motion, so re-derive each Hog's position at `now` (against walls and boulders,
 * like `wanderHogs`) and round to its tile before comparing — the same projection
 * the client renders, so a faced Hog matches what the player sees (invariant 3).
 */
function hogAt(ctx: Ctx, zoneId: string, x: number, y: number, now: Stamp) {
  const zone = getZone(zoneId);
  if (!zone) return undefined;
  const occupied = boulderTiles(ctx, zoneId);
  const bounds = zoneBounds(zone, (tx, ty) => occupied.has(tileKey(tx, ty)));
  for (const h of ctx.db.hog.zoneId.filter(zoneId)) {
    // A big 2×2 Hog is a fixture, not liftable — the carry overlay is one tile, and
    // a giant on your head makes no sense — so only common Hogs answer here.
    if (hogSize(h.style) > 1) continue;
    const pos = projectMotion(h, elapsedMs(h.movedAt, now), bounds);
    if (Math.round(pos.x) === x && Math.round(pos.y) === y) return h;
  }
  return undefined;
}

function hogTile(ctx: Ctx, h: NonNullable<ReturnType<typeof hogAt>>, now: Stamp): { x: number; y: number } {
  const zone = getZone(h.zoneId);
  if (!zone) return { x: h.x, y: h.y };
  const occupied = boulderTiles(ctx, h.zoneId);
  const bounds = zoneBounds(zone, (tx, ty) => occupied.has(tileKey(tx, ty)));
  const pos = projectMotion(h, elapsedMs(h.movedAt, now), bounds);
  return { x: Math.round(pos.x), y: Math.round(pos.y) };
}

/**
 * The online, living trogg currently on a tile in a zone, or undefined. Troggs do
 * not collide with each other, but sword attacks need a server-authoritative target
 * under the faced adjacent tile. Project each candidate at `now` with the same
 * bounds a trogg uses for movement, then round to its rendered tile.
 */
function playerAt(ctx: Ctx, zoneId: string, x: number, y: number, now: Stamp, exclude?: Ctx["sender"]) {
  const zone = getZone(zoneId);
  if (!zone) return undefined;
  const blockers = troggBlockers(ctx, zoneId, now);
  const bounds = zoneBounds(zone, (tx, ty) => blockers.has(tileKey(tx, ty)));
  for (const p of ctx.db.player.zoneId.filter(zoneId)) {
    if (!p.online || p.dead) continue;
    if (exclude && p.identity.isEqual(exclude)) continue;
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    if (Math.round(pos.x) === x && Math.round(pos.y) === y) return p;
  }
  return undefined;
}

function addMs(timestamp: Stamp, ms: number): Timestamp {
  return new Timestamp(timestamp.microsSinceUnixEpoch + BigInt(Math.round(ms)) * 1000n);
}

function scheduleRespawnAt(ctx: Ctx, playerId: Ctx["sender"], at: Stamp): void {
  ctx.db.playerRespawn.insert({ scheduledId: 0n, playerId, scheduledAt: ScheduleAt.time(at.microsSinceUnixEpoch) });
}

function respawnDue(p: { respawnAt?: Stamp }, now: Stamp): boolean {
  return !!p.respawnAt && elapsedMs(p.respawnAt, now) >= 0;
}

function respawnPlayer(ctx: Ctx, p: { identity: Ctx["sender"]; zoneId: string }): void {
  const current = ctx.db.player.identity.find(p.identity);
  if (!current || !current.dead) return;
  const zone = getZone(current.zoneId);
  if (!zone) return;
  const at = spawnAt(zone);
  ctx.db.player.identity.update({
    ...current,
    x: at.x,
    y: at.y,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    health: PLAYER_MAX_HEALTH,
    dead: false,
    respawnAt: undefined,
    movedAt: ctx.timestamp,
  });
}

type DamageResult = { health: number; killed: boolean };
type PlayerDamageResult = DamageResult & { droppedItemRows: number; droppedItemQty: number; respawnMs: number };

function playerDiedEvent(distinctId: string, props: Record<string, string | number | boolean>, cause: string, result: PlayerDamageResult): AnalyticsEvent {
  return {
    distinctId,
    event: "player_died",
    properties: {
      ...props,
      cause,
      dropped_item_rows: result.droppedItemRows,
      dropped_item_qty: result.droppedItemQty,
      respawn_ms: result.respawnMs,
    },
  };
}

function hogHealth(h: { health?: number }): number {
  return typeof h.health === "number" ? h.health : HOG_MAX_HEALTH;
}

function damageHog(ctx: Ctx, target: NonNullable<ReturnType<typeof hogAt>>, amount: number): DamageResult {
  const health = Math.max(0, hogHealth(target) - amount);
  if (health > 0) {
    ctx.db.hog.id.update({ ...target, health });
    return { health, killed: false };
  }
  ctx.db.hog.id.delete(target.id);
  return { health: 0, killed: true };
}

function dropInventory(ctx: Ctx, target: NonNullable<ReturnType<typeof playerAt>>, x: number, y: number): { rows: number; qty: number } {
  const zone = getZone(target.zoneId);
  if (!zone) return { rows: 0, qty: 0 };
  const rows = [...ctx.db.inventory.playerId.filter(target.identity)].filter((row) => row.qty > 0);
  if (rows.length === 0) return { rows: 0, qty: 0 };

  const occupied = solidTiles(ctx, target.zoneId, ctx.timestamp, target.identity);
  const face = facingDir(target);
  const tiles = spawnTiles(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), x, y, face.dirX, face.dirY, rows.length);
  let qty = 0;
  rows.forEach((row, i) => {
    const tile = tiles[i] ?? { x, y };
    occupied.add(tileKey(tile.x, tile.y));
    ctx.db.groundItem.insert({ id: 0n, zoneId: target.zoneId, item: row.item, x: tile.x, y: tile.y, qty: row.qty });
    qty += row.qty;
    ctx.db.inventory.id.delete(row.id);
  });
  return { rows: rows.length, qty };
}

/** Apply weapon damage to a trogg; zero health kills, drops inventory, and starts respawn. */
function damagePlayer(ctx: Ctx, target: NonNullable<ReturnType<typeof playerAt>>, amount: number): PlayerDamageResult {
  const health = Math.max(0, target.health - amount);
  if (health > 0) {
    ctx.db.player.identity.update({ ...target, health });
    return { health, killed: false, droppedItemRows: 0, droppedItemQty: 0, respawnMs: 0 };
  }

  const settled = settle(ctx, target, ctx.timestamp);
  let carrying = target.carrying;
  let carryingStyle = target.carryingStyle;
  if (carrying !== "") {
    const zone = getZone(target.zoneId);
    const occupied = solidTiles(ctx, target.zoneId, ctx.timestamp, target.identity);
    const face = facingDir(target);
    if (zone && placeCarried(ctx, zone, carrying, carryingStyle, occupied, settled.x, settled.y, face.dirX, face.dirY)) {
      carrying = "";
      carryingStyle = "";
    }
  }
  const dropped = dropInventory(ctx, target, settled.x, settled.y);
  const respawnAt = addMs(ctx.timestamp, PLAYER_RESPAWN_MS);
  scheduleRespawnAt(ctx, target.identity, respawnAt);

  ctx.db.player.identity.update({
    ...target,
    x: settled.x,
    y: settled.y,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    carrying,
    carryingStyle,
    equippedMainHand: "",
    equippedMainHandInventoryId: 0n,
    health: 0,
    dead: true,
    respawnAt,
    movedAt: ctx.timestamp,
  });
  return { health: 0, killed: true, droppedItemRows: dropped.rows, droppedItemQty: dropped.qty, respawnMs: PLAYER_RESPAWN_MS };
}

/** Throw a carried boulder or Hog in a straight cardinal line, damaging the first character hit. */
function throwCarried(
  ctx: Ctx,
  p: NonNullable<ReturnType<typeof playerAt>>,
  zone: Zone,
  pos: { x: number; y: number },
  dir: { dirX: number; dirY: number },
):
  | {
      kind: "boulder" | "hog";
      range: number;
      hitTarget?: "trogg" | "hog";
      damage?: number;
      killed: boolean;
      playerDeath?: PlayerDamageResult & { distinctId: string };
    }
  | undefined {
  if (p.carrying !== "boulder" && p.carrying !== "hog") return undefined;

  const sx = Math.round(pos.x);
  const sy = Math.round(pos.y);
  const pathOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  let lastFree: { x: number; y: number } | undefined;
  let hit: NonNullable<ReturnType<typeof playerAt>> | undefined;
  let hogHit: NonNullable<ReturnType<typeof hogAt>> | undefined;

  for (let step = 1; step <= THROWN_OBJECT_RANGE; step++) {
    const tx = sx + dir.dirX * step;
    const ty = sy + dir.dirY * step;
    if (!isWalkable(zone, tx, ty)) break;

    hit = playerAt(ctx, p.zoneId, tx, ty, ctx.timestamp, p.identity);
    if (hit) break;
    hogHit = hogAt(ctx, p.zoneId, tx, ty, ctx.timestamp);
    if (hogHit) break;

    if (pathOccupied.has(tileKey(tx, ty))) break;
    lastFree = { x: tx, y: ty };
  }

  let landing = lastFree;
  if (hit || hogHit) {
    const targetTile = hit ? snapToTile(settle(ctx, hit, ctx.timestamp)) : hogTile(ctx, hogHit!, ctx.timestamp);
    const landingOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp);
    landing = spawnTile(zone, (tx, ty) => landingOccupied.has(tileKey(tx, ty)), targetTile.x, targetTile.y, dir.dirX, dir.dirY) ?? lastFree;
  }

  if (!landing || !placeCarriedAt(ctx, zone, p.carrying, p.carryingStyle, landing)) return undefined;
  const range = Math.abs(dir.dirX !== 0 ? landing.x - sx : landing.y - sy);
  const result: {
    kind: "boulder" | "hog";
    range: number;
    hitTarget?: "trogg" | "hog";
    damage?: number;
    killed: boolean;
    playerDeath?: PlayerDamageResult & { distinctId: string };
  } = { kind: p.carrying, range, killed: false };
  if (hit) {
    const damage = damagePlayer(ctx, hit, THROWN_OBJECT_DAMAGE);
    result.hitTarget = "trogg";
    result.damage = THROWN_OBJECT_DAMAGE;
    result.killed = damage.killed;
    if (damage.killed) result.playerDeath = { ...damage, distinctId: hit.identity.toHexString() };
  }
  if (hogHit) {
    const damage = damageHog(ctx, hogHit, THROWN_OBJECT_DAMAGE);
    result.hitTarget = "hog";
    result.damage = THROWN_OBJECT_DAMAGE;
    result.killed = damage.killed;
  }
  ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
  return result;
}

/** Adjacent pickup candidates, with the faced tile first when the client has a heading. */
function pickupDirs(dir: { dirX: number; dirY: number } | null): { dirX: number; dirY: number }[] {
  if (!dir) return [];
  if (dir.dirX === 0 && dir.dirY === 0) return [...CARDINALS];
  return [dir, ...CARDINALS.filter((d) => d.dirX !== dir.dirX || d.dirY !== dir.dirY)];
}

/** The adjacent target `interact` should pick up, preferring the faced direction. */
function pickupTarget(ctx: Ctx, zoneId: string, x: number, y: number, dir: { dirX: number; dirY: number } | null, now: Stamp) {
  for (const d of pickupDirs(dir)) {
    const tx = x + d.dirX;
    const ty = y + d.dirY;
    const item = groundItemAt(ctx, zoneId, tx, ty);
    if (item) return { kind: "item" as const, row: item };
    const b = boulderAt(ctx, zoneId, tx, ty);
    if (b) return { kind: "boulder" as const, row: b };
    const h = hogAt(ctx, zoneId, tx, ty, now);
    if (h) return { kind: "hog" as const, row: h };
  }
  return undefined;
}

/** A Hog row's display style. Empty preserves existing id-derived rows; non-empty
 *  is used for Hogs that were carried and put down again. */
function effectiveHogStyle(h: { id: bigint; style?: string }): string {
  return hogStyleFor(h.id.toString(), h.style);
}

/**
 * Drop a carried entity (GDD "Interacting") onto the faced tile, or the nearest
 * free neighbour, then the trogg's own tile (`spawnTile`) — so a boulder never
 * lands in a wall or on another boulder. Returns false if every candidate is
 * blocked, leaving the trogg still carrying it. `x`/`y` are the trogg's settled
 * tile; `dirX`/`dirY` its facing (0,0 = no faced tile, take a neighbour).
 */
function placeCarried(
  ctx: Ctx,
  zone: Zone,
  kind: string,
  style: string,
  occupied: Set<string>,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
): boolean {
  const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), x, y, dirX, dirY);
  if (!tile) return false;
  return placeCarriedAt(ctx, zone, kind, style, tile);
}

/** Materialise a carried entity on an exact tile, enforcing the same caps as put-down. */
function placeCarriedAt(ctx: Ctx, zone: Zone, kind: string, style: string, tile: { x: number; y: number }): boolean {
  // Honour the per-zone cap on the put-down too, so picking up, spawning to the cap, then
  // dropping can't push a zone past its ceiling. Refusing keeps the trogg carrying — the
  // same outcome as a boxed-in drop — so nothing is lost.
  if (kind === "boulder") {
    if (countRows(ctx.db.boulder.zoneId.filter(zone.slug)) >= MAX_BOULDERS_PER_ZONE) return false;
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y });
  } else if (kind === "hog") {
    if (countRows(ctx.db.hog.zoneId.filter(zone.slug)) >= MAX_HOGS_PER_ZONE) return false;
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: tile.x, homeY: tile.y, style, health: HOG_MAX_HEALTH });
  } else {
    return false;
  }
  return true;
}

/** The direction a trogg visually faces: current motion while moving, standing facing otherwise. */
function facingDir(p: { dirX: number; dirY: number; faceX: number; faceY: number }): { dirX: number; dirY: number } {
  if (p.dirX !== 0 || p.dirY !== 0) return { dirX: p.dirX, dirY: p.dirY };
  return { dirX: p.faceX, dirY: p.faceY };
}

/** Coerce an untrusted axis input to -1, 0, or 1. */
function unitStep(value: number): number {
  return value === -1 || value === 1 ? value : 0;
}

/**
 * Resolve an untrusted (dirX, dirY) to a cardinal intent: idle, or one axis of
 * unit length. A diagonal (both axes set) is invalid — movement is 4-directional
 * — and returns null so the caller can reject it.
 */
function cardinal(dirX: number, dirY: number): { dirX: number; dirY: number } | null {
  const x = unitStep(dirX);
  const y = unitStep(dirY);
  if (x !== 0 && y !== 0) return null;
  return { dirX: x, dirY: y };
}
