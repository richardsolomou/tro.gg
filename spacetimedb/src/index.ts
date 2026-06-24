import { schema, table, t, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  CHAT_HISTORY_MAX,
  CHAT_MAX_CHARS,
  CHAT_RATE_LIMIT_MS,
  CLAIM_CODE_TTL_MS,
  COLOR_UNSET,
  facingTile,
  getZone,
  HOG_IDLE_CHANCE,
  HOG_WANDER_INTERVAL_MS,
  isColorIndex,
  isGeneratedName,
  isValidName,
  isWalkable,
  projectMotion,
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
 * colour. Both `running` and `color` carry defaults so adding them to the
 * already-published `player` table is an in-place migration, not a breaking one.
 * `hubUnlocked`/`equipment` are reserved for onboarding and equipment systems.
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
 * Unlike a trogg, a Hog's origin is an integer tile (`i32`): it re-bases at a whole
 * tile each wander tick (clients still glide between via `projectMotion`), and it
 * never pushes, so it needs no sub-tile precision. The motion columns carry
 * defaults so adding them to the already-published `hog` table is an in-place
 * migration, not a breaking one. dirX/dirY/movedAt default to idle-at-epoch.
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
  },
);

/**
 * The Hog wander timer (GDD "Hogs"). A scheduled table is SpacetimeDB's
 * deterministic timer — the only way state changes outside player input (invariant
 * 1: no simulation tick). Each tick fires `wanderHogs`, which repicks every Hog's
 * heading and then re-arms this timer *only while a player is online*, so an empty
 * zone settles its Hogs to rest and then does no further work (invariant 1).
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
    ctx.db.player.identity.update({ ...existing, x: pos.x, y: pos.y, dirX: 0, dirY: 0, running: false, online: true, movedAt: ctx.timestamp });
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
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp });
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
  ctx.db.player.identity.update({ ...p, x: settled.x, y: settled.y, dirX: 0, dirY: 0, running: false, online: false });
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

  const occupied = boulderTiles(ctx, p.zoneId);
  const pos = projectMotion(p, elapsedMs(p.movedAt, ctx.timestamp), zoneBounds(zone, (x, y) => occupied.has(tileKey(x, y))));

  const ahead = facingTile(pos.x, pos.y, p.dirX, p.dirY);
  if (!ahead) return; // not squarely facing a tile

  const b = boulderAt(ctx, p.zoneId, ahead.x, ahead.y);
  if (!b) return; // nothing to push

  const dest = { x: ahead.x + Math.sign(p.dirX), y: ahead.y + Math.sign(p.dirY) };
  if (!isWalkable(zone, dest.x, dest.y) || occupied.has(tileKey(dest.x, dest.y))) return; // blocked

  // `facingTile` already proved the trogg is on a tile centre; re-base its motion
  // to that whole tile so the grid-lock holds (GDD "Movement").
  const flush = snapToTile(pos);
  ctx.db.boulder.id.update({ ...b, x: dest.x, y: dest.y });
  ctx.db.player.identity.update({ ...p, x: flush.x, y: flush.y, movedAt: ctx.timestamp });
});

/**
 * The Hog wander tick (GDD "Hogs"). Settle each Hog to where it is now (against
 * walls and boulders, exactly like a trogg), then give it a fresh heading — a
 * random walkable cardinal, or idle so it pauses. Randomness is the context RNG,
 * seeded from the tick's timestamp, so the schedule replays deterministically
 * (invariant 3). The timer re-arms only while a player is online: with the zone
 * empty, every Hog is left at rest and the timer stops, so an empty zone does no
 * further work (invariant 1).
 */
export const wanderHogs = spacetimedb.reducer({ timer: hogWander.rowType }, (ctx) => {
  const online = anyPlayerOnline(ctx);
  const occupiedByZone = new Map<string, Set<string>>();

  for (const h of ctx.db.hog.iter()) {
    const zone = getZone(h.zoneId);
    if (!zone) continue;
    let occupied = occupiedByZone.get(h.zoneId);
    if (!occupied) {
      occupied = boulderTiles(ctx, h.zoneId);
      occupiedByZone.set(h.zoneId, occupied);
    }
    const bounds = zoneBounds(zone, (x, y) => occupied!.has(tileKey(x, y)));
    const pos = projectMotion(h, elapsedMs(h.movedAt, ctx.timestamp), bounds);
    // Re-base at a whole tile: the perpendicular axis is already integer, and
    // projectMotion stops flush at walls, so rounding the moving axis stays on
    // walkable floor (the `hog` origin is i32 — see the table definition).
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    const dir = online ? pickWanderDir(ctx, bounds, { x, y }) : { dirX: 0, dirY: 0 };
    ctx.db.hog.id.update({ ...h, x, y, dirX: dir.dirX, dirY: dir.dirY, movedAt: ctx.timestamp });
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

  // Boulders are the only collision obstacles; Hogs are non-colliding, so both
  // avoid spawning into a wall or onto an existing boulder, never onto a Hog.
  const occupied = boulderTiles(ctx, p.zoneId);
  const pos = settle(ctx, p, ctx.timestamp);
  const tile = spawnTile(zone, (x, y) => occupied.has(tileKey(x, y)), pos.x, pos.y, p.dirX, p.dirY);
  if (!tile) return;

  if (kind === "boulder") {
    ctx.db.boulder.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y });
  } else {
    // A spawned Hog starts at rest and joins the roamers — the next wander tick
    // gives it a heading like any other.
    ctx.db.hog.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp });
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

/** Arm a single one-shot Hog wander tick, unless one is already pending. */
function armWander(ctx: Ctx): void {
  if (ctx.db.hogWander.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(HOG_WANDER_INTERVAL_MS) * 1000n;
  ctx.db.hogWander.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

/** A Hog's next heading: a random walkable cardinal, or idle (`HOG_IDLE_CHANCE`)
 *  so it pauses rather than marching nonstop. */
function pickWanderDir(ctx: Ctx, bounds: ZoneBounds, pos: { x: number; y: number }): { dirX: number; dirY: number } {
  if (ctx.random() < HOG_IDLE_CHANCE) return { dirX: 0, dirY: 0 };
  const options = walkableCardinals(bounds, Math.round(pos.x), Math.round(pos.y));
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
type Settleable = { x: number; y: number; dirX: number; dirY: number; running: boolean; zoneId: string; movedAt: Stamp };

/**
 * Derive the trogg's position at `now` from its stored motion intent, colliding
 * against the zone's walls *and* its boulders (so a trogg settles flush against a
 * boulder, never inside it), then snap it to a whole tile: movement is grid-locked
 * (GDD "Movement"), so a stored origin is always a tile centre. The client only
 * sends `move` when the trogg is tile-aligned, so the snap is a no-op in the normal
 * case and a guard against a misbehaving client in the rest (invariant 3).
 */
function settle(ctx: Ctx, p: Settleable, now: Stamp): { x: number; y: number } {
  const zone = getZone(p.zoneId);
  if (!zone) return { x: p.x, y: p.y };
  const occupied = boulderTiles(ctx, p.zoneId);
  const bounds = zoneBounds(zone, (x, y) => occupied.has(tileKey(x, y)));
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

/** The boulder at a tile in a zone, or undefined. */
function boulderAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) {
    if (b.x === x && b.y === y) return b;
  }
  return undefined;
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
