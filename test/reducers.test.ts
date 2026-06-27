import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAT_HISTORY_MAX,
  CLAIM_CODE_TTL_MS,
  GHOST_HAUNT_HISTORY_MAX,
  getZone,
  HOG_MAX_HEALTH,
  hogStyleFor,
  INVENTORY_SLOT_COUNT,
  isWalkable,
  MAX_BOULDERS_PER_ZONE,
  MAX_GROUND_ITEMS_PER_ZONE,
  MAX_HOGS_PER_ZONE,
  parsePath,
  PLAYER_MAX_HEALTH,
  PLAYER_RESPAWN_MS,
  SPACETIMEAUTH_ISSUER,
  SWORD_DAMAGE,
  THROWN_OBJECT_DAMAGE,
} from "@trogg/shared";
import {
  chat,
  face,
  equipItem,
  hauntGhost,
  interact,
  move,
  moveTo,
  onConnect,
  onDisconnect,
  push,
  recolor,
  redeemClaim,
  rename,
  restyle,
  resetBoulders,
  resetHogs,
  respawn,
  respawnPlayers,
  spawn,
  startClaim,
  useEquipped,
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
  spawn(ctx, { kind: "boulder", item: "" });
  assert.equal(ctx.db.boulder.rows().length, MAX_BOULDERS_PER_ZONE);
});

test("spawn adds a boulder when the zone is below the cap", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  spawn(ctx, { kind: "boulder", item: "" });
  assert.equal(ctx.db.boulder.rows().length, 1);
  assert.equal(ctx.db.boulder.rows()[0].zoneId, ZONE);
});

test("spawn adds only one boulder per reducer call", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  for (let i = 0; i < MAX_BOULDERS_PER_ZONE - 2; i++) ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 1, y: 1 });
  spawn(ctx, { kind: "boulder", item: "" });
  assert.equal(ctx.db.boulder.rows().length, MAX_BOULDERS_PER_ZONE - 1);
});

test("spawn can add a registered ground item", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  spawn(ctx, { kind: "item", item: "sword" });
  assert.equal(ctx.db.groundItem.rows().length, 1);
  assert.equal(ctx.db.groundItem.rows()[0].item, "sword");
});

test("spawn refuses registered items that are not exposed in the Commands panel", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  spawn(ctx, { kind: "item", item: "stone" });
  assert.equal(ctx.db.groundItem.rows().length, 0);
});

test("spawn refuses ground items once the zone is at its cap", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  for (let i = 0; i < MAX_GROUND_ITEMS_PER_ZONE; i++) ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "stone", x: 1, y: 1 });
  spawn(ctx, { kind: "item", item: "sword" });
  assert.equal(ctx.db.groundItem.rows().length, MAX_GROUND_ITEMS_PER_ZONE);
});

test("spawn stores an explicit Hog sprite style", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  spawn(ctx, { kind: "hog", item: "snow" });
  assert.equal(ctx.db.hog.rows().length, 1);
  assert.equal(ctx.db.hog.rows()[0].style, "snow");
});

test("spawn stores an explicit big Hog sprite style", () => {
  const { ctx } = withPlayer({ x: 5, y: 8 });
  spawn(ctx, { kind: "hog", item: "dino" });
  assert.equal(ctx.db.hog.rows().length, 1);
  assert.equal(ctx.db.hog.rows()[0].style, "dino");
});

// --- Two Hogs never converge onto one tile (the wanderHogs fix) ---

test("two Hogs heading at the same tile do not both claim it", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: 0n, random: 0.99, integerInRange: (lo) => lo });
  ctx.db.player.insert(playerRow(me, { x: 2, y: 2, online: true }));
  // A at (5,8) heading right and B at (7,8) heading left both want the empty tile (6,8).
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 5, y: 8, dirX: 1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 5, homeY: 8, style: "" });
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 7, y: 8, dirX: -1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 7, homeY: 8, style: "" });

  wanderHogs(ctx, {});

  const dests = ctx.db.hog.rows().map((h: any) => `${h.x + h.dirX},${h.y + h.dirY}`);
  assert.notEqual(dests[0], dests[1]); // distinct destinations — no shared tile
});

// --- Big (2×2) Hogs block their whole footprint (the size-aware wander) ---

test("a common Hog won't step onto a big Hog's 2x2 footprint", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: 0n, random: 0.99, integerInRange: (lo) => lo });
  ctx.db.player.insert(playerRow(me, { x: 12, y: 12, online: true }));
  // A buff giant anchored at (3,7) covers (3,7),(4,7),(3,8),(4,8).
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 3, y: 7, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 3, homeY: 7, style: "buff" });
  // A common hog just right of it, heading left toward footprint tile (4,7).
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 5, y: 7, dirX: -1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 5, homeY: 7, style: "" });

  wanderHogs(ctx, {});

  const footprint = new Set(["3,7", "4,7", "3,8", "4,8"]);
  const common = ctx.db.hog.rows().find((h: any) => h.style === "");
  // Whatever heading it took, the tile it steps to next is outside the giant's footprint.
  assert.ok(!footprint.has(`${common.x + common.dirX},${common.y + common.dirY}`));
});

test("a big Hog keeps its whole 2x2 footprint on walkable floor as it wanders", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: micros(10_000), random: 0.99, integerInRange: (lo) => lo });
  ctx.db.player.insert(playerRow(me, { x: 12, y: 12, online: true }));
  // Heading right from (3,7); after a tile-crossing it re-bases and keeps its footprint clear.
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 3, y: 7, dirX: 1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 3, homeY: 7, style: "buff" });

  wanderHogs(ctx, {});

  const h = ctx.db.hog.rows().find((r: any) => r.style === "buff");
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    assert.ok(isWalkable(getZone(ZONE)!, h.x + dx, h.y + dy), `footprint tile (${h.x + dx}, ${h.y + dy}) off floor`);
  }
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
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 7, y: 8, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 7, homeY: 8, style: "" });
  push(ctx);
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 6, y: 8 }); // unmoved
});

// --- Movement authority ---

test("move rejects a diagonal intent and keeps the prior heading", () => {
  const { ctx, me } = withPlayer({ dirX: 0, dirY: 1, faceX: 0, faceY: 1 });
  move(ctx, { dirX: 1, dirY: 1, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, faceX: p.faceX, faceY: p.faceY }, { dirX: 0, dirY: 1, faceX: 0, faceY: 1 });
});

test("move stores an accepted cardinal intent and synced facing", () => {
  const { ctx, me } = withPlayer({ dirX: 0, dirY: 0, faceX: 0, faceY: 1 });
  move(ctx, { dirX: 1, dirY: 0, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, path: p.path, faceX: p.faceX, faceY: p.faceY }, { dirX: 1, dirY: 0, path: "", faceX: 1, faceY: 0 });
});

test("move preserves synced facing when stopping", () => {
  const { ctx, me } = withPlayer({ dirX: 1, dirY: 0, faceX: 1, faceY: 0 });
  move(ctx, { dirX: 0, dirY: 0, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, faceX: p.faceX, faceY: p.faceY }, { dirX: 0, dirY: 0, faceX: 1, faceY: 0 });
});

test("face stores a standing turn without starting movement", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, dirX: 0, dirY: 0, faceX: 0, faceY: 1 });
  face(ctx, { dirX: -1, dirY: 0 });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ x: p.x, y: p.y, dirX: p.dirX, dirY: p.dirY, faceX: p.faceX, faceY: p.faceY, path: p.path }, { x: 5, y: 8, dirX: 0, dirY: 0, faceX: -1, faceY: 0, path: "" });
});

test("face rejects a diagonal standing turn", () => {
  const { ctx, me } = withPlayer({ faceX: 0, faceY: 1 });
  face(ctx, { dirX: 1, dirY: 1 });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ faceX: p.faceX, faceY: p.faceY }, { faceX: 0, faceY: 1 });
});

// --- Interacting ---

test("interact picks up the boulder on the faced tile", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 6, y: 8 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.boulder.rows().length, 0); // removed from the world
  assert.equal(ctx.db.player.identity.find(me).carrying, "boulder"); // now carried
});

test("interact picks up a faced ground item into inventory", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "pickaxe", x: 6, y: 8 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.groundItem.rows().length, 0);
  assert.equal(ctx.db.inventory.rows().length, 1);
  assert.equal(ctx.db.inventory.rows()[0].playerId.isEqual(me), true);
  assert.equal(ctx.db.inventory.rows()[0].item, "pickaxe");
});

test("non-stackable equippable pickups stay as separate inventory rows", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "sword", x: 6, y: 8 });
  interact(ctx, { dirX: 1, dirY: 0 });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "sword", x: 5, y: 9 });
  interact(ctx, { dirX: 0, dirY: 1 });

  const swords = ctx.db.inventory.rows().filter((r: any) => r.playerId.isEqual(me) && r.item === "sword");
  assert.equal(swords.length, 2);
  assert.deepEqual(swords.map((r: any) => r.qty), [1, 1]);
});

test("interact leaves a ground item in place when inventory has no free slot", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  for (let i = 0; i < INVENTORY_SLOT_COUNT; i++) ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  const item = ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "pickaxe", x: 6, y: 8 });

  interact(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.inventory.rows().length, INVENTORY_SLOT_COUNT);
  assert.equal(ctx.db.groundItem.id.find(item.id)?.item, "pickaxe");
});

test("stackable pickups merge into an existing row even when inventory slots are full", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  const stone = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "stone", qty: 3 });
  for (let i = 1; i < INVENTORY_SLOT_COUNT; i++) ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "stone", x: 6, y: 8, qty: 2 });

  interact(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.inventory.rows().length, INVENTORY_SLOT_COUNT);
  assert.equal(ctx.db.inventory.id.find(stone.id)?.qty, 5);
  assert.equal(ctx.db.groundItem.rows().length, 0);
});

test("equipItem equips only a specific owned equippable row", () => {
  const { ctx, me } = withPlayer({});
  equipItem(ctx, { inventoryId: 999n });
  assert.equal(ctx.db.player.identity.find(me).equippedMainHand, "");
  const first = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  const second = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  const stone = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "stone", qty: 3 });

  equipItem(ctx, { inventoryId: first.id });
  assert.equal(ctx.db.player.identity.find(me).equippedMainHand, "sword");
  assert.equal(ctx.db.player.identity.find(me).equippedMainHandInventoryId, first.id);
  equipItem(ctx, { inventoryId: stone.id });
  assert.equal(ctx.db.player.identity.find(me).equippedMainHandInventoryId, first.id);
  equipItem(ctx, { inventoryId: second.id });
  assert.equal(ctx.db.player.identity.find(me).equippedMainHandInventoryId, second.id);
});

test("useEquipped mines a faced boulder with a pickaxe without stopping movement", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, dirX: 1, dirY: 0, running: true, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 6, y: 8 });
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.boulder.rows().length, 0);
  assert.equal(ctx.db.inventory.rows().find((r: any) => r.item === "stone")?.qty, 1);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.equipmentAction, "pickaxe");
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, running: p.running, path: p.path }, { dirX: 1, dirY: 0, running: true, path: "" });
});

test("useEquipped does not mine a boulder when there is no slot for a new stone stack", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  for (let i = 1; i < INVENTORY_SLOT_COUNT; i++) ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  const boulder = ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 6, y: 8 });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.boulder.id.find(boulder.id)?.x, 6);
  assert.equal(ctx.db.inventory.rows().some((r: any) => r.item === "stone"), false);
});

test("useEquipped damages a faced adjacent trogg with a sword", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 6, y: 8, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH - SWORD_DAMAGE);
  assert.equal(target.dead, false);
  assert.equal(ctx.db.player.identity.find(me).equipmentAction, "sword");
});

test("a sword hit at zero health kills, drops inventory, and respawns after the timer", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, equippedMainHand: "sword" }, { now: micros(1000) });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { name: "SameName", color: 1, style: 2, x: 6, y: 8, dirX: 1, dirY: 0, running: true, movedAt: { microsSinceUnixEpoch: micros(1000) }, health: SWORD_DAMAGE, equippedMainHand: "pickaxe", equippedMainHandInventoryId: 10n }));
  ctx.db.inventory.insert({ id: 0n, playerId: other, item: "pickaxe", qty: 1 });
  ctx.db.inventory.insert({ id: 0n, playerId: other, item: "stone", qty: 3 });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  let target = ctx.db.player.identity.find(other);
  assert.equal(target.health, 0);
  assert.equal(target.dead, true);
  assert.equal(target.equippedMainHand, "");
  assert.equal(target.equippedMainHandInventoryId, 0n);
  assert.equal(target.respawnAt.microsSinceUnixEpoch, micros(1000 + PLAYER_RESPAWN_MS));
  assert.deepEqual({ x: target.x, y: target.y, dirX: target.dirX, dirY: target.dirY, running: target.running, path: target.path }, { x: 6, y: 8, dirX: 0, dirY: 0, running: false, path: "" });
  assert.equal(ctx.db.inventory.playerId.filter(other).length, 0);
  assert.deepEqual(
    ctx.db.groundItem
      .rows()
      .map((r: any) => [r.item, r.qty])
      .sort(),
    [
      ["pickaxe", 1],
      ["stone", 3],
    ],
  );
  assert.equal(ctx.db.playerRespawn.rows().length, 1);

  (ctx as any).sender = other;
  move(ctx, { dirX: -1, dirY: 0, running: false });
  target = ctx.db.player.identity.find(other);
  assert.deepEqual({ x: target.x, y: target.y, dirX: target.dirX, dirY: target.dirY, dead: target.dead }, { x: 6, y: 8, dirX: 0, dirY: 0, dead: true });

  respawn(ctx);
  target = ctx.db.player.identity.find(other);
  assert.equal(target.dead, true);

  ctx.timestamp = { microsSinceUnixEpoch: micros(1000 + PLAYER_RESPAWN_MS) };
  respawnPlayers(ctx, { timer: ctx.db.playerRespawn.rows()[0] });
  target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH);
  assert.equal(target.dead, false);
  assert.equal(target.respawnAt, undefined);
  assert.equal(target.name, "SameName");
  assert.equal(target.color, 1);
  assert.equal(target.style, 2);
  assert.deepEqual({ x: target.x, y: target.y }, { x: 12, y: 8 });
});

test("useEquipped damages a faced adjacent Hog with a sword", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const h = hogAt_(ctx, 6, 8);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.hog.id.find(h.id).health, HOG_MAX_HEALTH - SWORD_DAMAGE);
});

test("sword damage removes a Hog at zero health", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  hogAt_(ctx, 6, 8, SWORD_DAMAGE);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.hog.rows().length, 0);
});

test("useEquipped throws a carried boulder into a trogg and lands it past the target", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "boulder", equippedMainHand: "" });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 7, y: 8, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH - THROWN_OBJECT_DAMAGE);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 8, y: 8 });
});

test("useEquipped throws a carried Hog into a trogg", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "hog", equippedMainHand: "" });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 6, y: 8, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(other).health, PLAYER_MAX_HEALTH - THROWN_OBJECT_DAMAGE);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const h = ctx.db.hog.rows()[0];
  assert.deepEqual({ x: h.x, y: h.y, dirX: h.dirX, dirY: h.dirY }, { x: 7, y: 8, dirX: 0, dirY: 0 });
});

test("useEquipped throws a carried boulder into a Hog", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "boulder", equippedMainHand: "" });
  const h = hogAt_(ctx, 7, 8);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.hog.id.find(h.id).health, HOG_MAX_HEALTH - THROWN_OBJECT_DAMAGE);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 8, y: 8 });
});

test("useEquipped throws a carried object to max range when it hits no trogg", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "boulder", equippedMainHand: "" });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 9, y: 8 });
});

test("interact prioritizes the faced pickup when several entities are adjacent", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 5, y: 7 });
  hogAt_(ctx, 6, 8);
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "hog");
  assert.equal(ctx.db.hog.rows().length, 0);
  assert.equal(ctx.db.boulder.rows().length, 1);
});

test("interact prioritizes a faced ground item over other adjacent pickups", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8, carrying: "" });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 5, y: 7 });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "sword", x: 6, y: 8 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.groundItem.rows().length, 0);
  assert.equal(ctx.db.boulder.rows().length, 1);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(ctx.db.inventory.rows()[0].playerId.isEqual(me), true);
  assert.equal(ctx.db.inventory.rows()[0].item, "sword");
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

// --- Ghost haunts ---

test("hauntGhost inserts a zone-scoped haunt on a walkable tile", () => {
  const { ctx } = withPlayer({}, { integerInRange: (_lo, hi) => hi });
  hauntGhost(ctx);

  const row = ctx.db.ghostHaunt.rows()[0];
  assert.equal(row.zoneId, ZONE);
  assert.equal(row.createdAt.microsSinceUnixEpoch, 0n);
  assert.ok(isWalkable(getZone(ZONE)!, row.x, row.y));
});

test("hauntGhost trims old haunt rows to the cap", () => {
  const { ctx } = withPlayer({});
  for (let i = 0; i < GHOST_HAUNT_HISTORY_MAX; i++) {
    ctx.db.ghostHaunt.insert({ id: 0n, zoneId: ZONE, x: 1, y: 1, createdAt: { microsSinceUnixEpoch: 0n } });
  }
  const oldestId = ctx.db.ghostHaunt.rows()[0].id;

  hauntGhost(ctx);

  const rows = ctx.db.ghostHaunt.rows();
  assert.equal(rows.length, GHOST_HAUNT_HISTORY_MAX);
  assert.equal(rows.find((r: any) => r.id === oldestId), undefined);
});

// --- helpers for the entity tables ---
const hogAt_ = (ctx: FakeCtx, x: number, y: number, over: number | string | { health?: number; style?: string } = {}) => {
  const health = typeof over === "number" ? over : typeof over === "object" ? (over.health ?? HOG_MAX_HEALTH) : HOG_MAX_HEALTH;
  const style = typeof over === "string" ? over : typeof over === "object" ? (over.style ?? "") : "";
  return ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x, y, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: x, homeY: y, health, style });
};

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
  assert.equal(ctx.db.hog.rows().length, getZone(ZONE)!.hogs.length + getZone(ZONE)!.bigHogs.length);
  assert.equal(ctx.db.groundItem.rows().length, getZone(ZONE)!.items.length);
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

test("connecting a second tab for the same account does not reset active movement", () => {
  const me = id("account");
  const first = id("tab-1");
  const second = id("tab-2");
  const ctx = makeCtx({ sender: me, connectionId: second, now: micros(250) });
  ctx.db.player.insert(playerRow(me, { online: true, x: 5, y: 8, dirX: 1, dirY: 0, running: true, movedAt: { microsSinceUnixEpoch: 0n } }));
  ctx.db.playerConnection.insert({ connectionId: first.toHexString(), playerId: me, connectedAt: { microsSinceUnixEpoch: 0n } });

  onConnect(ctx);

  const p = ctx.db.player.identity.find(me);
  assert.equal(p.online, true);
  assert.equal(p.dirX, 1);
  assert.equal(p.dirY, 0);
  assert.equal(p.running, true);
  assert.equal(p.movedAt.microsSinceUnixEpoch, 0n);
  assert.equal(ctx.db.playerConnection.rows().length, 2);
});

test("disconnecting one duplicate account tab keeps the shared trogg online", () => {
  const me = id("account");
  const first = id("tab-1");
  const second = id("tab-2");
  const ctx = makeCtx({ sender: me, connectionId: first });
  ctx.db.player.insert(playerRow(me, { online: true, x: 5, y: 8, dirX: 1, dirY: 0, carrying: "boulder" }));
  ctx.db.playerConnection.insert({ connectionId: first.toHexString(), playerId: me, connectedAt: { microsSinceUnixEpoch: 0n } });
  ctx.db.playerConnection.insert({ connectionId: second.toHexString(), playerId: me, connectedAt: { microsSinceUnixEpoch: 0n } });

  onDisconnect(ctx);

  const p = ctx.db.player.identity.find(me);
  assert.equal(p.online, true);
  assert.equal(p.dirX, 1);
  assert.equal(p.carrying, "boulder");
  assert.equal(ctx.db.boulder.rows().length, 0);
  assert.equal(ctx.db.playerConnection.rows().length, 1);
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
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, faceX: p.faceX, faceY: p.faceY }, { dirX: 1, dirY: 0, faceX: 1, faceY: 0 });
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

test("interact preserves a Hog's style while carried and after put-down", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8 });
  hogAt_(ctx, 6, 8, "ember");

  interact(ctx, { dirX: 1, dirY: 0 });
  const carrying = ctx.db.player.identity.find(me);
  assert.equal(carrying.carrying, "hog");
  assert.equal(carrying.carryingStyle, "ember");

  interact(ctx, { dirX: 1, dirY: 0 });
  const dropped = ctx.db.hog.rows()[0];
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(ctx.db.player.identity.find(me).carryingStyle, "");
  assert.equal(dropped.style, "ember");
});

test("interact stores the effective id-derived Hog style for legacy rows", () => {
  const { ctx, me } = withPlayer({ x: 5, y: 8 });
  const hog = hogAt_(ctx, 6, 8);

  interact(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(me).carryingStyle, hogStyleFor(hog.id.toString()));
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
  assert.equal(ctx.db.hog.rows().length, getZone(ZONE)!.hogs.length + getZone(ZONE)!.bigHogs.length);
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

test("restyle to a valid style index updates the style", () => {
  const { ctx, me } = withPlayer({ style: -1 });
  restyle(ctx, { style: 1 });
  assert.equal(ctx.db.player.identity.find(me).style, 1);
});

test("restyle to an out-of-range index is rejected", () => {
  const { ctx, me } = withPlayer({ style: 0 });
  restyle(ctx, { style: 999 });
  assert.equal(ctx.db.player.identity.find(me).style, 0);
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
