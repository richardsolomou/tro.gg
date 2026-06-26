import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAT_HISTORY_MAX,
  CLAIM_CODE_TTL_MS,
  getZone,
  MAX_BOULDERS_PER_ZONE,
  MAX_HOGS_PER_ZONE,
  parsePath,
  SPACETIMEAUTH_ISSUER,
} from "@trogg/shared";
import {
  chat,
  interact,
  move,
  moveTo,
  onConnect,
  onDisconnect,
  push,
  recolor,
  redeemClaim,
  rename,
  resetBoulders,
  resetHogs,
  spawn,
  startClaim,
  wanderHogs,
} from "../spacetimedb/src/index.ts";
import { id, makeCtx, playerRow, type FakeCtx } from "./spacetime.ts";

const ZONE = "hog-town";
const micros = (ms: number) => BigInt(ms) * 1000n;

/** Seed a ctx whose sender is an online player at `(x, y)`. */
function withPlayer(over: Record<string, unknown> = {}, ctxOver: Partial<Parameters<typeof makeCtx>[0]> = {}) {
  const me = id("me");
  const ctx = makeCtx({ sender: me, ...ctxOver });
  ctx.db.player.insert(playerRow(me, over));
  return { ctx, me };
}

// --- Entity caps (the unbounded-spawn DoS fix) ---

test("spawn refuses a boulder once the zone is at its cap", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  for (let i = 0; i < MAX_BOULDERS_PER_ZONE; i++) ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 1, y: 1 });
  spawn(ctx, { kind: "boulder" });
  assert.equal(ctx.db.boulder.rows().length, MAX_BOULDERS_PER_ZONE);
});

test("spawn adds a boulder when the zone is below the cap", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  spawn(ctx, { kind: "boulder" });
  assert.equal(ctx.db.boulder.rows().length, 1);
  assert.equal(ctx.db.boulder.rows()[0].zoneId, ZONE);
});

// --- Two Hogs never converge onto one tile (the wanderHogs fix) ---

test("two Hogs heading at the same tile do not both claim it", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: 0n, random: 0.99, integerInRange: (lo) => lo });
  ctx.db.player.insert(playerRow(me, { x: 2, y: 2, online: true }));
  // A at (5,8) heading right and B at (7,8) heading left both want the empty tile (6,8).
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 5, y: 8, dirX: 1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 5, homeY: 8 });
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 7, y: 8, dirX: -1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 7, homeY: 8 });

  wanderHogs(ctx, {});

  const dests = ctx.db.hog.rows().map((h: any) => `${h.x + h.dirX},${h.y + h.dirY}`);
  assert.notEqual(dests[0], dests[1]); // distinct destinations — no shared tile
});

// --- Guest -> account upgrade never destroys a carried entity (the redeemClaim fix) ---

test("claiming an account mid-carry folds the carried entity onto the account", () => {
  const guest = id("guest");
  const account = id("account");
  const ctx = makeCtx({ sender: account, now: micros(1000), issuer: SPACETIMEAUTH_ISSUER });
  ctx.db.player.insert(playerRow(guest, { carrying: "boulder", isGuest: true, name: "trogg-aaaa" }));
  ctx.db.player.insert(playerRow(account, { carrying: "", isGuest: false, name: "trogg-bbbb" }));
  ctx.db.claimCode.insert({ code: "code-1", guest, createdAt: { microsSinceUnixEpoch: 0n } });

  redeemClaim(ctx, { code: "code-1" });

  assert.equal(ctx.db.player.identity.find(guest), undefined); // guest folded away
  assert.equal(ctx.db.player.identity.find(account).carrying, "boulder"); // carry preserved
});

test("redeemClaim consumes a stale nonce but does not fold a TTL-expired claim", () => {
  const guest = id("guest");
  const account = id("account");
  const ctx = makeCtx({ sender: account, now: micros(CLAIM_CODE_TTL_MS + 1000), issuer: SPACETIMEAUTH_ISSUER });
  ctx.db.player.insert(playerRow(guest, { isGuest: true }));
  ctx.db.player.insert(playerRow(account, { isGuest: false }));
  ctx.db.claimCode.insert({ code: "stale", guest, createdAt: { microsSinceUnixEpoch: 0n } });

  redeemClaim(ctx, { code: "stale" });

  assert.equal(ctx.db.claimCode.code.find("stale"), undefined); // nonce always consumed
  assert.ok(ctx.db.player.identity.find(guest)); // but the guest is left intact (not folded)
});

// --- Pushing (server re-validates the shove) ---

test("push shoves a boulder onto clear floor and re-bases the trogg flush", () => {
  const { ctx } = withPlayer({ x: 5, y: 8, dirX: 1, dirY: 0 });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 6, y: 8 });
  push(ctx);
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 7, y: 8 });
});

test("push refuses when a Hog stands beyond the boulder", () => {
  const { ctx } = withPlayer({ x: 5, y: 8, dirX: 1, dirY: 0 });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 6, y: 8 });
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 7, y: 8, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 7, homeY: 8 });
  push(ctx);
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 6, y: 8 }); // unmoved
});

// --- Movement authority ---

test("move rejects a diagonal intent and keeps the prior heading", () => {
  const { ctx, me } = withPlayer({ dirX: 0, dirY: 1 });
  move(ctx, { dirX: 1, dirY: 1, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY }, { dirX: 0, dirY: 1 });
});

test("move stores an accepted cardinal intent", () => {
  const { ctx, me } = withPlayer({ dirX: 0, dirY: 0 });
  move(ctx, { dirX: 1, dirY: 0, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, path: p.path }, { dirX: 1, dirY: 0, path: "" });
});

// --- Interacting ---

test("interact picks up the boulder on the faced tile", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 6, y: 8 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.boulder.rows().length, 0); // removed from the world
  assert.equal(ctx.db.player.identity.find(me).carrying, "boulder"); // now carried
});

// --- Chat ---

test("chat enforces the per-player rate limit", () => {
  const { ctx } = withPlayer({}, { now: micros(10_000) });
  chat(ctx, { text: "one" });
  chat(ctx, { text: "two" }); // same timestamp → within the 1s limit
  assert.equal(ctx.db.chatMessage.rows().length, 1);
});

test("chat trims zone history to the cap, dropping the oldest line", () => {
  const { ctx } = withPlayer({}, { now: micros(10_000) });
  for (let i = 0; i < CHAT_HISTORY_MAX; i++) {
    ctx.db.chatMessage.insert({ id: 0n, zoneId: ZONE, sender: id("x"), name: "x", text: `m${i}`, createdAt: { microsSinceUnixEpoch: 0n } });
  }
  const oldestId = ctx.db.chatMessage.rows()[0].id;
  chat(ctx, { text: "newest" });
  const rows = ctx.db.chatMessage.rows();
  assert.equal(rows.length, CHAT_HISTORY_MAX);
  assert.equal(rows.find((r: any) => r.id === oldestId), undefined); // oldest dropped
});

// --- helpers for the entity tables ---
const hogAt_ = (ctx: FakeCtx, x: number, y: number) =>
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x, y, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: x, homeY: y });

// --- Connect / disconnect lifecycle ---

test("connecting as a guest inserts an online guest and lazily seeds the zone", () => {
  const me = id("newguest");
  const ctx = makeCtx({ sender: me });
  onConnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.ok(p);
  assert.equal(p.isGuest, true);
  assert.equal(p.online, true);
  assert.equal(ctx.db.boulder.rows().length, getZone(ZONE)!.boulders.length);
  assert.equal(ctx.db.hog.rows().length, getZone(ZONE)!.hogs.length);
});

test("connecting with a SpacetimeAuth token inserts an account, not a guest", () => {
  const me = id("acct");
  const ctx = makeCtx({ sender: me, issuer: SPACETIMEAUTH_ISSUER, jwtPayload: { preferred_username: "Spike" } });
  onConnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.isGuest, false);
  assert.equal(p.name, "Spike"); // valid, free provider username adopted
});

test("reconnecting flips an existing trogg back online without duplicating it", () => {
  const me = id("ret");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { online: false, x: 5, y: 8, name: "Keepme" }));
  onConnect(ctx);
  const mine = ctx.db.player.rows().filter((r: any) => r.identity.isEqual(me));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].online, true);
  assert.equal(mine[0].name, "Keepme");
});

test("a returning trogg embedded in a wall is nudged to spawn", () => {
  const me = id("stuck");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { online: false, x: 0, y: 0 })); // (0,0) is a rim wall
  onConnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ x: p.x, y: p.y }, { x: 12, y: 8 }); // zone centre (spawnAt)
});

test("disconnecting drops the carried entity into the world and marks the trogg offline", () => {
  const me = id("leaver");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { carrying: "boulder", x: 5, y: 8, online: true }));
  onDisconnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.online, false);
  assert.equal(p.carrying, "");
  assert.equal(ctx.db.boulder.rows().length, 1);
});

// --- Click-to-move pathfinding ---

test("moveTo stores a cardinal route toward a reachable tile", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8 });
  moveTo(ctx, { x: 8, y: 8, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.equal(parsePath(p.path).at(-1)?.x, 8); // route ends at the target column
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY }, { dirX: 1, dirY: 0 });
});

// --- Interacting: put-down, the cap on drop, and Hog pickup ---

test("interact puts a carried boulder down on the faced tile", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "boulder" });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(ctx.db.boulder.rows().length, 1);
});

test("a drop is refused at the entity cap, so the trogg keeps carrying", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "hog" });
  for (let i = 0; i < MAX_HOGS_PER_ZONE; i++) hogAt_(ctx, 1, 1);
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "hog"); // still carrying
  assert.equal(ctx.db.hog.rows().length, MAX_HOGS_PER_ZONE); // no overflow
});

test("interact picks up a Hog on the faced tile", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8 });
  hogAt_(ctx, 6, 8);
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.hog.rows().length, 0);
  assert.equal(ctx.db.player.identity.find(me).carrying, "hog");
});

// --- Reset commands restore the registry layout ---

test("resetBoulders restores the zone's registry boulder layout", () => {
  const { ctx } = withPlayer({});
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 1, y: 1 }); // a shoved/extra boulder
  resetBoulders(ctx);
  const reg = getZone(ZONE)!.boulders;
  const keys = new Set(ctx.db.boulder.rows().map((b: any) => `${b.x},${b.y}`));
  assert.deepEqual(keys, new Set(reg.map((c) => `${c.x},${c.y}`)));
});

test("resetHogs restores the zone's registry Hog population", () => {
  const { ctx } = withPlayer({});
  hogAt_(ctx, 1, 1);
  hogAt_(ctx, 2, 2);
  resetHogs(ctx);
  assert.equal(ctx.db.hog.rows().length, getZone(ZONE)!.hogs.length);
});

// --- Rename / recolor (validation + uniqueness) ---

test("rename to a free valid name updates the trogg and rewrites its chat lines", () => {
  const { ctx, me } = withPlayer({ name: "trogg-aaaa" });
  ctx.db.chatMessage.insert({ id: 0n, zoneId: ZONE, sender: me, name: "trogg-aaaa", text: "hi", createdAt: { microsSinceUnixEpoch: 0n } });
  rename(ctx, { name: "Mossy" });
  assert.equal(ctx.db.player.identity.find(me).name, "Mossy");
  assert.equal(ctx.db.chatMessage.rows()[0].name, "Mossy"); // denormalised name rewritten
});

test("rename to a name another trogg holds (case-insensitive) is rejected", () => {
  const { ctx, me } = withPlayer({ name: "trogg-aaaa" });
  ctx.db.player.insert(playerRow(id("other"), { name: "Taken" }));
  rename(ctx, { name: "taken" });
  assert.equal(ctx.db.player.identity.find(me).name, "trogg-aaaa");
});

test("rename to an invalid name is rejected", () => {
  const { ctx, me } = withPlayer({ name: "trogg-aaaa" });
  rename(ctx, { name: "no" }); // too short
  assert.equal(ctx.db.player.identity.find(me).name, "trogg-aaaa");
});

test("recolor to a valid palette index updates the colour", () => {
  const { ctx, me } = withPlayer({ color: -1 });
  recolor(ctx, { color: 0 });
  assert.equal(ctx.db.player.identity.find(me).color, 0);
});

test("recolor to an out-of-range index is rejected", () => {
  const { ctx, me } = withPlayer({ color: 0 });
  recolor(ctx, { color: 999 });
  assert.equal(ctx.db.player.identity.find(me).color, 0);
});

// --- startClaim (the nonce side of the upgrade) ---

const UUID = "11111111-1111-1111-1111-111111111111";
const UUID2 = "22222222-2222-2222-2222-222222222222";

test("startClaim registers a UUID nonce under the guest", () => {
  const { ctx, me } = withPlayer({ isGuest: true });
  startClaim(ctx, { code: UUID });
  const row = ctx.db.claimCode.code.find(UUID);
  assert.ok(row);
  assert.ok(row.guest.isEqual(me));
});

test("startClaim rejects a non-UUID code", () => {
  const { ctx } = withPlayer({ isGuest: true });
  startClaim(ctx, { code: "not-a-uuid" });
  assert.equal(ctx.db.claimCode.iter().length, 0);
});

test("startClaim replaces the guest's previous pending nonce", () => {
  const { ctx } = withPlayer({ isGuest: true });
  startClaim(ctx, { code: UUID });
  startClaim(ctx, { code: UUID2 });
  assert.equal(ctx.db.claimCode.code.find(UUID), undefined);
  assert.ok(ctx.db.claimCode.code.find(UUID2));
});

test("startClaim is a no-op for a non-guest", () => {
  const { ctx } = withPlayer({ isGuest: false });
  startClaim(ctx, { code: UUID });
  assert.equal(ctx.db.claimCode.iter().length, 0);
});

// --- redeemClaim (name inherit + caller authorisation) ---

test("redeemClaim carries the guest's chosen name onto a freshly-named account", () => {
  const guest = id("guest");
  const account = id("account");
  const ctx = makeCtx({ sender: account, now: micros(1000), issuer: SPACETIMEAUTH_ISSUER });
  ctx.db.player.insert(playerRow(guest, { isGuest: true, name: "Pebble" })); // chosen, non-generated
  ctx.db.player.insert(playerRow(account, { isGuest: false, name: "trogg-bbbb" })); // still generated
  ctx.db.claimCode.insert({ code: "c", guest, createdAt: { microsSinceUnixEpoch: 0n } });
  redeemClaim(ctx, { code: "c" });
  assert.equal(ctx.db.player.identity.find(account).name, "Pebble");
});

test("redeemClaim ignores a caller without a SpacetimeAuth token", () => {
  const guest = id("guest");
  const account = id("account");
  const ctx = makeCtx({ sender: account, now: micros(1000) }); // no issuer
  ctx.db.claimCode.insert({ code: "c", guest, createdAt: { microsSinceUnixEpoch: 0n } });
  redeemClaim(ctx, { code: "c" });
  assert.ok(ctx.db.claimCode.code.find("c")); // nonce untouched
});
