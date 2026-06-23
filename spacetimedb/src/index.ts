import { schema, table, t, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import {
  CHAT_HISTORY_MAX,
  CHAT_MAX_CHARS,
  CHAT_RATE_LIMIT_MS,
  CLAIM_CODE_TTL_MS,
  getZone,
  isGeneratedName,
  isValidName,
  projectMotion,
  SPACETIMEAUTH_ISSUER,
  STARTING_ZONE_SLUG,
  type Zone,
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
 * WASD direction, and `movedAt`; position over time is derived, and settled back
 * into (x, y) on the next input or on disconnect. `color` is derived client-side
 * from the identity, never stored (GDD "Avatars"). `hubUnlocked`/`equipment` land
 * with M1/M2.
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
  },
);

/**
 * One zone-scoped chat line (GDD "Chat"). Clients subscribe to recent rows in
 * their zone, and a freshly inserted row *is* the live bubble. `name` is
 * denormalised so late joiners render history without a lookup. Content never
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

const spacetimedb = schema({ player, chatMessage, claimCode });

/** The fully-typed reducer context for this module's tables (used by extracted helpers). */
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export default spacetimedb;

export const init = spacetimedb.init(() => {});

/**
 * A client connected. Resume the existing trogg (mark it online) or spawn a fresh
 * one at the zone centre. The durable row already is the player — there is no
 * separate load step.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    ctx.db.player.identity.update({ ...existing, online: true, movedAt: ctx.timestamp });
    return;
  }

  // A connection authenticated by a SpacetimeAuth OIDC token is an account, not a
  // guest (its identity is stable across browsers/devices). Any other token —
  // including SpacetimeDB's own self-issued anonymous one — is a guest.
  const isAccount = isSpacetimeAuthCaller(ctx);

  const zone = getZone(STARTING_ZONE_SLUG)!;
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
    x: Math.floor(zone.width / 2),
    y: Math.floor(zone.height / 2),
    dirX: 0,
    dirY: 0,
    movedAt: ctx.timestamp,
    online: true,
    lastChatAt: undefined,
  });
});

/**
 * A client disconnected. Settle the trogg to where it is *now* and mark it
 * offline (clients subscribe to online players only, so it leaves their view
 * without losing durable progress).
 */
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const settled = settle(p, ctx.timestamp);
  ctx.db.player.identity.update({ ...p, x: settled.x, y: settled.y, dirX: 0, dirY: 0, online: false });
});

/**
 * A WASD direction intent (GDD "Movement"). Settle the origin to where the trogg
 * is now (so elapsed travel under the old direction isn't lost or replayed), then
 * store the new direction and timestamp. Position is never ticked (invariant 1).
 */
export const move = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32() }, (ctx, { dirX, dirY }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const settled = settle(p, ctx.timestamp);
  ctx.db.player.identity.update({
    ...p,
    x: settled.x,
    y: settled.y,
    dirX: unitStep(dirX),
    dirY: unitStep(dirY),
    movedAt: ctx.timestamp,
  });
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
 * line, and the client sees its name simply not change.
 */
export const rename = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;

  const trimmed = name.trim();
  if (!isValidName(trimmed) || nameTaken(ctx, trimmed, ctx.sender)) return;

  ctx.db.player.identity.update({ ...p, name: trimmed });
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
type Settleable = { x: number; y: number; dirX: number; dirY: number; zoneId: string; movedAt: Stamp };

/** Derive the trogg's position at `now` from its stored motion intent. */
function settle(p: Settleable, now: Stamp): { x: number; y: number } {
  const zone: Zone | undefined = getZone(p.zoneId);
  const bounds = zone ? { width: zone.width, height: zone.height } : { width: 1, height: 1 };
  return projectMotion(p, elapsedMs(p.movedAt, now), bounds);
}

/** Milliseconds between two timestamps. */
function elapsedMs(from: Stamp, to: Stamp): number {
  return Number(to.microsSinceUnixEpoch - from.microsSinceUnixEpoch) / 1000;
}

/** Coerce an untrusted axis input to -1, 0, or 1. */
function unitStep(value: number): number {
  return value === -1 || value === 1 ? value : 0;
}
