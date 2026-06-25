import { schema, table, t, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  CHAT_HISTORY_MAX,
  CHAT_MAX_CHARS,
  CHAT_RATE_LIMIT_MS,
  CLAIM_CODE_TTL_MS,
  COLOR_UNSET,
  facingTile,
  findPath,
  getZone,
  HOG_IDLE_CHANCE,
  HOG_STEP_INTERVAL_MS,
  HOG_TURN_CHANCE,
  isColorIndex,
  isGeneratedName,
  isValidName,
  isWalkable,
  projectMotion,
  serializePath,
  snapToTile,
  SPACETIMEAUTH_ISSUER,
  spawnTile,
  STARTING_ZONE_SLUG,
  walkableCardinals,
  type Zone,
  type ZoneBounds,
  zoneBounds,
} from "../../shared/index";

/**
 * The tro.gg backend (GDD "Data model"): durable tables that clients subscribe to
 * directly, mutated only by reducers. Identity is the connection's own
 * cryptographic `ctx.sender` (invariant 3: never client-asserted). There is no simulation tick
 * (invariant 1): state changes only inside a reducer, on player input or a
 * lifecycle event; position between inputs is derived with `projectMotion`, never
 * advanced on a timer.
 */

/**
 * A trogg. The durable row is keyed by the player's Identity, so a returning
 * visitor who reconnects with the same stored token resumes the same trogg.
 * Motion is intent-based (invariants 1 & 2): the row holds an origin (x, y), a
 * WASD direction, `running`, and `movedAt`; position over time is derived, and
 * settled back into (x, y) on the next input or on disconnect. `running` (shift
 * held) rides the intent so every client derives the same speed (GDD "Movement").
 * `color` is the chosen avatar palette index (GDD "Avatars"), set by `recolor`; it
 * defaults to `COLOR_UNSET` (-1) so an unchosen trogg falls back to its id-derived
 * colour. `carrying` is the kind of tile-sized entity the trogg holds (GDD
 * "Interacting"), set by `interact`; "" when empty-handed.
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
    // entity. Boulders/hogs are fungible (no identity, seeded from the registry), so
    // the kind is all the client needs to draw the carry overlay — no id to keep.
    carrying: t.string().default(""),
    // Click-to-move waypoints, serialized as "x,y;x,y;..." and interpreted by
    // shared `projectMotion` (GDD "Movement"). Empty = no path / direct WASD.
    path: t.string().default(""),
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
 * `projectMotion` and there's no per-frame sync (invariant 2). Hogs are
 * server-owned (no identity): seeded per zone from the `ZONES` registry on first
 * connect, dropped by the `/spawn` debug command, then moved only by the scheduled
 * `wanderHogs` reducer. Merchant/dialogue Hog roles are separate later work.
 *
 * Unlike a trogg, a Hog's origin is an integer tile (`i32`): it ambles tile-to-tile,
 * re-based to each whole tile it reaches (clients still glide between via
 * `projectMotion`), and it never pushes, so it needs no sub-tile precision. The
 * `path`/`homeX`/`homeY` columns are unused by the amble — retained from an earlier
 * home-anchored pathfinding wander, kept only so the shipped schema isn't reordered
 * (columns are appended at the end, never moved — see the migration note above).
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

const spacetimedb = schema({ player, chatMessage, claimCode, boulder, hog, hogWander });
export default spacetimedb;

/** The reducer context, typed against this module's schema (db view + sender). */
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

export const init = spacetimedb.init(() => {});

/**
 * A client connected. Resume the existing trogg (mark it online) or spawn a fresh
 * one at the zone centre. The durable row already is the player — there is no
 * separate load step.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  // The boulder/hog tables are new, so init (first-publish only) never seeded them
  // on an already-published module; seed lazily on connect, idempotently.
  const startingZone = getZone(STARTING_ZONE_SLUG)!;
  seedBoulders(ctx, startingZone);
  seedHogs(ctx, startingZone);
  // A player is here, so make sure the Hogs are roaming (no-op if already armed).
  armWander(ctx);

  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
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
    path: "",
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

/** Seed a zone's roaming Hogs from the registry, unless it already has some. */
function seedHogs(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.hog.zoneId.filter(zone.slug)].length > 0) return;
  for (const h of zone.hogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y });
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
  const settled = settle(ctx, p, ctx.timestamp);
  // Drop whatever the trogg was carrying where it stops, so a carried entity is
  // never orphaned while its carrier is offline (GDD "Interacting"). If it's boxed
  // in and can't be placed, keep it on the row — it's durable and still droppable
  // when the trogg returns.
  let carrying = p.carrying;
  if (carrying !== "") {
    const zone = getZone(p.zoneId);
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    if (zone && placeCarried(ctx, zone, carrying, occupied, settled.x, settled.y, p.dirX, p.dirY)) carrying = "";
  }
  ctx.db.player.identity.update({ ...p, x: settled.x, y: settled.y, dirX: 0, dirY: 0, running: false, path: "", online: false, carrying });
});

/**
 * A WASD direction intent (GDD "Movement"). Movement is 4-directional — one
 * cardinal axis at a time, no diagonals (like Pokémon/Zelda). Settle the origin
 * to where the trogg is now (so elapsed travel under the old direction — and the
 * old speed — isn't lost or replayed), then store the new direction, `running`,
 * and timestamp. `running` (shift held) rides the intent so all clients derive the
 * same faster speed (GDD "Movement"). Position is never ticked (invariant 1). A
 * diagonal intent is rejected, not coerced (invariant 3 — never trust the client):
 * the trogg holds its prior motion.
 */
export const move = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32(), running: t.bool() }, (ctx, { dirX, dirY, running }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
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
 * Interact with the tile a trogg faces (GDD "Interacting") — a generic action key
 * (client `E`). Today the one effect is pick up / put down a tile-sized entity:
 * empty-handed, lift the boulder or hog on the faced tile onto the trogg (delete
 * its world row, stamp `carrying`); already carrying, set it back down on the faced
 * tile. It's a toggle. The faced direction is passed in because an idle trogg's
 * standing facing isn't synced (GDD "Movement"); the server still re-derives the
 * trogg's tile and only acts on the entity actually on the adjacent faced tile, so
 * the client can't reach past its neighbours (invariant 3). Future interactions
 * (switches, fires, item pickups) branch in here on the faced target.
 */
export const interact = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32() }, (ctx, { dirX, dirY }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;

  const dir = cardinal(dirX, dirY);
  const pos = settle(ctx, p, ctx.timestamp);

  if (p.carrying !== "") {
    // Put down: place the held entity on the faced tile, or the nearest free
    // neighbour (spawnTile). A boxed-in trogg can't drop, so it keeps carrying.
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    const place = placeCarried(ctx, zone, p.carrying, occupied, pos.x, pos.y, dir?.dirX ?? 0, dir?.dirY ?? 0);
    if (place) ctx.db.player.identity.update({ ...p, carrying: "" });
    return;
  }

  // Pick up the boulder or hog on the tile the trogg squarely faces.
  if (!dir || (dir.dirX === 0 && dir.dirY === 0)) return;
  const ax = Math.round(pos.x) + dir.dirX;
  const ay = Math.round(pos.y) + dir.dirY;

  const b = boulderAt(ctx, p.zoneId, ax, ay);
  if (b) {
    ctx.db.boulder.id.delete(b.id);
    ctx.db.player.identity.update({ ...p, carrying: "boulder" });
    return;
  }
  const h = hogAt(ctx, p.zoneId, ax, ay, ctx.timestamp);
  if (h) {
    ctx.db.hog.id.delete(h.id);
    ctx.db.player.identity.update({ ...p, carrying: "hog" });
  }
});

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
  const settled: { hog: HogRow; x: number; y: number; zone: Zone; blockers: Set<string> }[] = [];
  const hogTilesByZone = new Map<string, Set<string>>();
  for (const h of hogList) {
    const zone = getZone(h.zoneId);
    if (!zone) continue;
    const blockers = blockersFor(h.zoneId);
    const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
    // Round the in-between position to the tile it ended on: a Hog steps tile-to-tile
    // over walkable floor, so rounding stays on walkable floor (the `hog` origin is i32).
    const pos = projectMotion(h, elapsedMs(h.movedAt, now), bounds);
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    settled.push({ hog: h, x, y, zone, blockers });
    let tiles = hogTilesByZone.get(h.zoneId);
    if (!tiles) {
      tiles = new Set<string>();
      hogTilesByZone.set(h.zoneId, tiles);
    }
    tiles.add(tileKey(x, y));
  }

  // Pass 2: pick each Hog's heading against walls, boulders, troggs, and the other
  // Hogs' settled tiles — its own tile excepted, so it isn't blocked by itself. While
  // the zone is empty, leave every Hog at rest.
  for (const s of settled) {
    const hogTiles = hogTilesByZone.get(s.hog.zoneId)!;
    const ownTile = tileKey(s.x, s.y);
    const bounds = zoneBounds(s.zone, (x, y) => {
      const k = tileKey(x, y);
      return k !== ownTile && (s.blockers.has(k) || hogTiles.has(k));
    });
    const dir = online ? pickWanderDir(ctx, bounds, s.hog, { x: s.x, y: s.y }) : { dirX: 0, dirY: 0 };

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
 * Spawn a boulder or Hog at the caller's location — the `/spawn` debug command
 * (optionally gated client-side by `spawn-command`). The server re-derives the
 * trogg's tile authoritatively (invariant 3) and places the entity on the tile
 * it faces, falling back to a free neighbour, so nothing lands inside a wall or
 * on another boulder. An unknown kind or a boxed-in trogg is a silent no-op.
 */
export const spawn = spacetimedb.reducer({ kind: t.string() }, (ctx, { kind }) => {
  if (kind !== "boulder" && kind !== "hog") return;

  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;

  // Drop the entity on free floor — never inside a wall or on top of anything solid
  // (a boulder, a Hog, or another trogg), now that Hogs and troggs collide.
  const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  const pos = settle(ctx, p, ctx.timestamp);
  const tile = spawnTile(zone, (x, y) => occupied.has(tileKey(x, y)), pos.x, pos.y, p.dirX, p.dirY);
  if (!tile) return;

  if (kind === "boulder") {
    ctx.db.boulder.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y });
  } else {
    // A spawned Hog starts at rest and joins the roamers — the next wander tick
    // gives it a heading like any other.
    ctx.db.hog.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: tile.x, homeY: tile.y });
  }
});

/**
 * Reset the caller's zone boulders to their `ZONES` registry positions (GDD
 * "Pushing"). Clears the zone's boulders and reseeds from the registry — the single
 * source of truth — so a layout shoved out of shape snaps back. Fired by the in-chat
 * `/reset` command; open like every reducer, with the optional `boulder-reset`
 * flag gating the client command.
 */
export const resetBoulders = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;
  for (const b of [...ctx.db.boulder.zoneId.filter(zone.slug)]) ctx.db.boulder.id.delete(b.id);
  seedBoulders(ctx, zone);
});

/**
 * Reset the caller's zone Hogs to their `ZONES` registry population (GDD "Hogs").
 * Clears the zone's Hogs and reseeds from the registry — the single source of
 * truth — so a zone overrun with `/spawn`ed Hogs snaps back to its intended
 * count. The mirror of `resetBoulders`. A Hog a trogg is carrying lives on the
 * player row, not the `hog` table, so it survives the cull and re-materialises on
 * put-down (GDD "Interacting"). Fired by the in-chat `/reset hedgehogs` command;
 * open like every reducer, with the optional `hog-reset` flag gating the client
 * command.
 */
export const resetHogs = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;
  for (const h of [...ctx.db.hog.zoneId.filter(zone.slug)]) ctx.db.hog.id.delete(h.id);
  seedHogs(ctx, zone);
});

/**
 * A zone-scoped chat line. Validate length, enforce the per-player rate limit
 * (invariant 3 — never trust the client), append the row, and trim the zone's
 * history to its cap.
 */
export const chat = spacetimedb.reducer({ text: t.string() }, (ctx, { text }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;

  const trimmed = text.trim().slice(0, CHAT_MAX_CHARS);
  if (!trimmed) return;

  if (p.lastChatAt && elapsedMs(p.lastChatAt, ctx.timestamp) < CHAT_RATE_LIMIT_MS) return;
  ctx.db.player.identity.update({ ...p, lastChatAt: ctx.timestamp });

  ctx.db.chatMessage.insert({
    id: 0n,
    zoneId: p.zoneId,
    sender: ctx.sender,
    name: p.name,
    text: trimmed,
    createdAt: ctx.timestamp,
  });

  // Keep only the most recent CHAT_HISTORY_MAX lines per zone; auto-inc id is the
  // insertion order, so the lowest ids are the oldest.
  const lines = [...ctx.db.chatMessage.zoneId.filter(p.zoneId)].sort((a, b) => Number(a.id - b.id));
  for (let i = 0; i < lines.length - CHAT_HISTORY_MAX; i++) {
    ctx.db.chatMessage.id.delete(lines[i]!.id);
  }
});

/**
 * Rename the caller's trogg (GDD "Identity": names are unique, 3–20 chars,
 * alphanumeric + hyphen). This is how a player swaps the generated `trogg-####`
 * for one they choose. Validation and the uniqueness scan run server-side
 * (invariant 3); an invalid or taken name is a silent no-op, like a rejected chat
 * line, and the client sees its name simply not change. The denormalised name on
 * the player's past chat lines is rewritten too, so history shows their current
 * name rather than whatever they were called when each line was sent.
 */
export const rename = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;

  const trimmed = name.trim();
  if (trimmed === p.name || !isValidName(trimmed) || nameTaken(ctx, trimmed, ctx.sender)) return;

  ctx.db.player.identity.update({ ...p, name: trimmed });
  for (const line of ctx.db.chatMessage.iter()) {
    if (line.sender.isEqual(ctx.sender)) ctx.db.chatMessage.id.update({ ...line, name: trimmed });
  }
});

/**
 * Recolour the caller's trogg (GDD "Avatars and equipment"): store a chosen index
 * into the shared `TROGG_COLORS` palette, replacing the id-derived default. The
 * index is validated server-side (invariant 3); an out-of-range index or one
 * already set is a silent no-op, like `rename`. The colour rides the zone player
 * sync, so the tint updates for everyone; chat name colour is derived from the
 * same row, so no denormalised copy needs rewriting.
 */
export const recolor = spacetimedb.reducer({ color: t.i32() }, (ctx, { color }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (color === p.color || !isColorIndex(color)) return;
  ctx.db.player.identity.update({ ...p, color });
});

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

  // Carry the guest's chosen name onto a freshly-named account (never clobber a
  // returning account's own name), staying within the uniqueness rule.
  const inheritName =
    !isGeneratedName(guest.name) && isGeneratedName(account.name) && !nameTaken(ctx, guest.name, ctx.sender);
  ctx.db.player.identity.update({ ...account, name: inheritName ? guest.name : account.name, isGuest: false });
  ctx.db.player.identity.delete(guest.identity);
});

/** Whether any player is currently online — the Hogs only roam while someone is
 *  watching (invariant 1: an empty zone does no work). */
function anyPlayerOnline(ctx: Ctx): boolean {
  for (const p of ctx.db.player.iter()) if (p.online) return true;
  return false;
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
): { dirX: number; dirY: number } {
  const options = walkableCardinals(bounds, pos.x, pos.y);
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

/** A Timestamp, narrowed to the field this module reads. */
type Stamp = { microsSinceUnixEpoch: bigint };

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

/** "x,y" key for a tile, used to test occupancy in O(1). */
function tileKey(x: number, y: number): string {
  return `${x},${y}`;
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

/** Add each Hog's current tile (projected to `now`, against walls + boulders) to `set`. */
function addHogTiles(ctx: Ctx, zoneId: string, now: Stamp, set: Set<string>): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  const boulders = boulderTiles(ctx, zoneId);
  const bounds = zoneBounds(zone, (x, y) => boulders.has(tileKey(x, y)));
  for (const h of ctx.db.hog.zoneId.filter(zoneId)) {
    const pos = projectMotion(h, elapsedMs(h.movedAt, now), bounds);
    set.add(tileKey(Math.round(pos.x), Math.round(pos.y)));
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

/** The boulder at a tile in a zone, or undefined. */
function boulderAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) {
    if (b.x === x && b.y === y) return b;
  }
  return undefined;
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
    const pos = projectMotion(h, elapsedMs(h.movedAt, now), bounds);
    if (Math.round(pos.x) === x && Math.round(pos.y) === y) return h;
  }
  return undefined;
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
  occupied: Set<string>,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
): boolean {
  const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), x, y, dirX, dirY);
  if (!tile) return false;
  if (kind === "boulder") {
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y });
  } else if (kind === "hog") {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: tile.x, homeY: tile.y });
  } else {
    return false;
  }
  return true;
}

/** Milliseconds between two timestamps. */
function elapsedMs(from: Stamp, to: Stamp): number {
  return Number(to.microsSinceUnixEpoch - from.microsSinceUnixEpoch) / 1000;
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
