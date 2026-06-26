import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAT_HISTORY_MAX,
  CLAIM_CODE_TTL_MS,
  MAX_BOULDERS_PER_ZONE,
  SPACETIMEAUTH_ISSUER,
} from "@trogg/shared";
import { chat, interact, move, push, redeemClaim, spawn, wanderHogs } from "../spacetimedb/src/index.ts";
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
