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
  MOVE_SPEED_TILES_PER_SEC,
  EMERGE_ARRIVAL,
  CAVE_DOOR,
  birthZoneFor,
  isBirthZone,
  CHEAT_SPEED_MULTIPLIER,
  FLY_VERTICAL_TILES_PER_SEC,
  FLY_MAX_HEIGHT,
  FLY_CLEAR_OBSTACLE,
  DEEP_WATER_TILE,
  rockHeightAt,
  tileGlyph,
  projectMotionState,
  projectMotion,
  zoneBounds,
  MAX_GROUND_ITEMS_PER_ZONE,
  MAX_HOGS_PER_ZONE,
  parsePath,
  PLAYER_MAX_HEALTH,
  PLAYER_RESPAWN_MS,
  SPACETIMEAUTH_ISSUER,
  WEAPON_DAMAGE,
  BOULDER_MAX_HEALTH,
  OFF_TOOL_NODE_FACTOR,
  TREE_MAX_HEALTH,
  THROWN_OBJECT_DAMAGE,
  UNARMED_DAMAGE,
  HEALTH_REGEN_DELAY_MS,
  HEALTH_REGEN_FRACTION,
  hogMaxHealth,
  NPC_CORPSE_MS,
  hogLoot,
} from "@trogg/shared";
import {
  chat,
  discardItem,
  dropItem,
  face,
  equipItem,
  hauntGhost,
  interact,
  move,
  moveTo,
  onConnect,
  emerge,
  enterCave,
  onDisconnect,
  recolor,
  redeemClaim,
  rename,
  restyle,
  resetBoulders,
  resetHogs,
  setCheats,
  setLift,
  setSky,
  healSelf,
  rescue,
  respawnPlayers,
  regenCreatures,
  spawn,
  startClaim,
  useEquipped,
  wanderHogs,
} from "../spacetimedb/src/index.ts";
import { id, makeCtx, playerRow, type FakeCtx } from "./spacetime.ts";

const ZONE = "world";
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
  const { ctx } = withPlayer({ x: 69, y: 96 });
  for (let i = 0; i < MAX_BOULDERS_PER_ZONE; i++) ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 65, y: 89 });
  spawn(ctx, { kind: "boulder", item: "" });
  assert.equal(ctx.db.boulder.rows().length, MAX_BOULDERS_PER_ZONE);
});

test("spawn adds a boulder when the zone is below the cap", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "boulder", item: "" });
  assert.equal(ctx.db.boulder.rows().length, 1);
  assert.equal(ctx.db.boulder.rows()[0].zoneId, ZONE);
});

test("spawn adds only one boulder per reducer call", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  for (let i = 0; i < MAX_BOULDERS_PER_ZONE - 2; i++) ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 65, y: 89 });
  spawn(ctx, { kind: "boulder", item: "" });
  assert.equal(ctx.db.boulder.rows().length, MAX_BOULDERS_PER_ZONE - 1);
});

test("spawn can add a registered ground item", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "item", item: "sword" });
  assert.equal(ctx.db.groundItem.rows().length, 1);
  assert.equal(ctx.db.groundItem.rows()[0].item, "sword");
});

test("spawn refuses registered items that are not exposed in the Commands panel", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "item", item: "quill" });
  assert.equal(ctx.db.groundItem.rows().length, 0);
});

test("spawn refuses ground items once the zone is at its cap", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  for (let i = 0; i < MAX_GROUND_ITEMS_PER_ZONE; i++) ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "stone", x: 65, y: 89 });
  spawn(ctx, { kind: "item", item: "sword" });
  assert.equal(ctx.db.groundItem.rows().length, MAX_GROUND_ITEMS_PER_ZONE);
});

test("spawn stores an explicit Hog sprite style", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "hog", item: "snow" });
  assert.equal(ctx.db.hog.rows().length, 1);
  assert.equal(ctx.db.hog.rows()[0].style, "snow");
});

test("spawn stores an explicit big Hog sprite style", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "hog", item: "dino" });
  assert.equal(ctx.db.hog.rows().length, 1);
  assert.equal(ctx.db.hog.rows()[0].style, "dino");
});

// --- Two Hogs never converge onto one tile (the wanderHogs fix) ---

test("two Hogs heading at the same tile do not both claim it", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: 0n, random: 0.99, integerInRange: (lo) => lo });
  ctx.db.player.insert(playerRow(me, { x: 66, y: 90, online: true }));
  // A at (5,8) heading right and B at (7,8) heading left both want the empty tile (6,8).
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, dirX: 1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 5, homeY: 8, style: "" });
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 71, y: 96, dirX: -1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 7, homeY: 8, style: "" });

  wanderHogs(ctx, {});

  const dests = ctx.db.hog.rows().map((h: any) => `${h.x + h.dirX},${h.y + h.dirY}`);
  assert.notEqual(dests[0], dests[1]); // distinct destinations — no shared tile
});

// --- Big (2×2) Hogs block their whole footprint (the size-aware wander) ---

test("a common Hog won't step onto a big Hog's 2x2 footprint", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: 0n, random: 0.99, integerInRange: (lo) => lo });
  ctx.db.player.insert(playerRow(me, { x: 76, y: 100, online: true }));
  // A buff giant anchored at (3,7) covers (3,7),(4,7),(3,8),(4,8).
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 67, y: 95, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 3, homeY: 7, style: "buff" });
  // A common hog just right of it, heading left toward footprint tile (4,7).
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 69, y: 95, dirX: -1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 5, homeY: 7, style: "" });

  wanderHogs(ctx, {});

  const footprint = new Set(["3,7", "4,7", "3,8", "4,8"]);
  const common = ctx.db.hog.rows().find((h: any) => h.style === "");
  // Whatever heading it took, the tile it steps to next is outside the giant's footprint.
  assert.ok(!footprint.has(`${common.x + common.dirX},${common.y + common.dirY}`));
});

test("a big Hog keeps its whole 2x2 footprint on walkable floor as it wanders", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: micros(10_000), random: 0.99, integerInRange: (lo) => lo });
  ctx.db.player.insert(playerRow(me, { x: 76, y: 100, online: true }));
  // Heading right from (3,7); after a tile-crossing it re-bases and keeps its footprint clear.
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 67, y: 95, dirX: 1, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 3, homeY: 7, style: "buff" });

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

// --- Movement authority ---

test("move accepts a diagonal intent, facing its dominant axis (free movement)", () => {
  const { ctx, me } = withPlayer({ dirX: 0, dirY: 1, faceX: 0, faceY: 1 });
  move(ctx, { dirX: 1, dirY: 1, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, faceX: p.faceX, faceY: p.faceY }, { dirX: 1, dirY: 1, faceX: 1, faceY: 0 });
});

test("move clamps heading axes to the wire scale, never trusting the client", () => {
  const { ctx, me } = withPlayer({ dirX: 0, dirY: 0, faceX: 0, faceY: 1 });
  move(ctx, { dirX: 999999, dirY: -407, running: false });
  const p = ctx.db.player.identity.find(me);
  // Magnitude never buys speed (the projection normalises); axes clamp to ±1000.
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY }, { dirX: 1000, dirY: -407 });
});

test("an off-axis heading moves at unit speed along its direction", () => {
  const { ctx, me } = withPlayer({ x: 108, y: 105, dirX: 0, dirY: 0 });
  move(ctx, { dirX: 966, dirY: -259, running: false }); // ~15° above east
  const p = ctx.db.player.identity.find(me);
  const zone = getZone(ZONE)!;
  const at = projectMotion(p, 1_000, zoneBounds(zone));
  const dist = Math.hypot(at.x - 108, at.y - 105);
  assert.ok(Math.abs(dist - MOVE_SPEED_TILES_PER_SEC) < 1e-6, `moved ${dist}`);
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
  const { ctx, me } = withPlayer({ x: 69, y: 96, dirX: 0, dirY: 0, faceX: 0, faceY: 1 });
  face(ctx, { dirX: -1, dirY: 0 });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ x: p.x, y: p.y, dirX: p.dirX, dirY: p.dirY, faceX: p.faceX, faceY: p.faceY, path: p.path }, { x: 69, y: 96, dirX: 0, dirY: 0, faceX: -1, faceY: 0, path: "" });
});

test("face rejects a diagonal standing turn", () => {
  const { ctx, me } = withPlayer({ faceX: 0, faceY: 1 });
  face(ctx, { dirX: 1, dirY: 1 });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ faceX: p.faceX, faceY: p.faceY }, { faceX: 0, faceY: 1 });
});

// --- Interacting ---

test("interact does not pick up a boulder — boulders are mining nodes", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "" });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.boulder.rows().length, 1); // still in the world
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
});

test("interact picks up a faced ground item into inventory", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "" });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "pickaxe", x: 70, y: 96 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.groundItem.rows().length, 0);
  assert.equal(ctx.db.inventory.rows().length, 1);
  assert.equal(ctx.db.inventory.rows()[0].playerId.isEqual(me), true);
  assert.equal(ctx.db.inventory.rows()[0].item, "pickaxe");
});

test("pickup reaches by radius, not facing — the nearest item wins", () => {
  const { ctx } = withPlayer({ x: 69, y: 96, carrying: "", faceX: 0, faceY: 1 });
  // behind the trogg relative to its facing, still inside the radius
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "sword", x: 69, y: 95 });
  // and one clearly out of reach
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "shield", x: 65, y: 90 });
  interact(ctx, { dirX: 0, dirY: 1 }); // facing away from the sword
  assert.equal(ctx.db.inventory.rows()[0]?.item, "sword");
  assert.equal(ctx.db.groundItem.rows()[0]?.item, "shield"); // out of radius, untouched
});

test("non-stackable equippable pickups stay as separate inventory rows", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "" });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "sword", x: 70, y: 96 });
  interact(ctx, { dirX: 1, dirY: 0 });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "sword", x: 69, y: 97 });
  interact(ctx, { dirX: 0, dirY: 1 });

  const swords = ctx.db.inventory.rows().filter((r: any) => r.playerId.isEqual(me) && r.item === "sword");
  assert.equal(swords.length, 2);
  assert.deepEqual(swords.map((r: any) => r.qty), [1, 1]);
});

test("interact leaves a ground item in place when inventory has no free slot", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "" });
  for (let i = 0; i < INVENTORY_SLOT_COUNT; i++) ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  const item = ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "pickaxe", x: 70, y: 96 });

  interact(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.inventory.rows().length, INVENTORY_SLOT_COUNT);
  assert.equal(ctx.db.groundItem.id.find(item.id)?.item, "pickaxe");
});

test("stackable pickups merge into an existing row even when inventory slots are full", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "" });
  const stone = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "stone", qty: 3 });
  for (let i = 1; i < INVENTORY_SLOT_COUNT; i++) ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "stone", x: 70, y: 96, qty: 2 });

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

test("equipItem routes a shield to the off hand and toggles it independently of the main hand", () => {
  const { ctx, me } = withPlayer({});
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  const shield = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "shield", qty: 1 });

  equipItem(ctx, { inventoryId: sword.id });
  equipItem(ctx, { inventoryId: shield.id });
  let p = ctx.db.player.identity.find(me);
  assert.equal(p.equippedMainHand, "sword");
  assert.equal(p.equippedMainHandInventoryId, sword.id);
  assert.equal(p.equippedOffHand, "shield");
  assert.equal(p.equippedOffHandInventoryId, shield.id);

  equipItem(ctx, { inventoryId: shield.id });
  p = ctx.db.player.identity.find(me);
  assert.equal(p.equippedOffHand, "");
  assert.equal(p.equippedOffHandInventoryId, 0n);
  assert.equal(p.equippedMainHand, "sword");
  assert.equal(p.equippedMainHandInventoryId, sword.id);
});

test("dropItem removes a non-stackable row and lays it on the ground", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  dropItem(ctx, { inventoryId: sword.id });
  assert.equal(ctx.db.inventory.id.find(sword.id), undefined);
  const ground = ctx.db.groundItem.rows();
  assert.equal(ground.length, 1);
  assert.equal(ground[0].item, "sword");
  assert.equal(ground[0].zoneId, ZONE);
});

test("dropItem decrements a stack and lays one unit on the ground", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const stone = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "stone", qty: 3 });
  dropItem(ctx, { inventoryId: stone.id });
  assert.equal(ctx.db.inventory.id.find(stone.id)?.qty, 2);
  assert.equal(ctx.db.groundItem.rows().length, 1);
  assert.equal(ctx.db.groundItem.rows()[0].item, "stone");
});

test("dropItem unequips the main hand when the dropped row was equipped", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  dropItem(ctx, { inventoryId: sword.id });
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.equippedMainHand, "");
  assert.equal(p.equippedMainHandInventoryId, 0n);
});

test("dropItem keeps the item when the zone is at its ground-item cap", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  for (let i = 0; i < MAX_GROUND_ITEMS_PER_ZONE; i++) ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "stone", x: 65, y: 89 });
  dropItem(ctx, { inventoryId: sword.id });
  assert.equal(ctx.db.inventory.id.find(sword.id)?.item, "sword");
  assert.equal(ctx.db.groundItem.rows().length, MAX_GROUND_ITEMS_PER_ZONE);
});

test("dropItem ignores an inventory row the caller does not own", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const theirs = ctx.db.inventory.insert({ id: 0n, playerId: id("other"), item: "sword", qty: 1 });
  dropItem(ctx, { inventoryId: theirs.id });
  assert.equal(ctx.db.inventory.id.find(theirs.id)?.item, "sword");
  assert.equal(ctx.db.groundItem.rows().length, 0);
});

test("discardItem destroys a non-stackable row without creating a ground item", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  discardItem(ctx, { inventoryId: sword.id });
  assert.equal(ctx.db.inventory.id.find(sword.id), undefined);
  assert.equal(ctx.db.groundItem.rows().length, 0);
});

test("discardItem decrements a stack by one unit", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const stone = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "stone", qty: 3 });
  discardItem(ctx, { inventoryId: stone.id });
  assert.equal(ctx.db.inventory.id.find(stone.id)?.qty, 2);
  assert.equal(ctx.db.groundItem.rows().length, 0);
});

test("discardItem unequips the main hand when the discarded row was equipped", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  discardItem(ctx, { inventoryId: sword.id });
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.equippedMainHand, "");
  assert.equal(p.equippedMainHandInventoryId, 0n);
});

test("mining takes swings: each hit chips the boulder, the breaking hit grants stone", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, dirX: 1, dirY: 0, running: true, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  const b = ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: BOULDER_MAX_HEALTH });

  // the mock RNG rolls the floor of the pickaxe's range every swing
  const perHit = WEAPON_DAMAGE.pickaxe![0];
  const swings = Math.ceil(BOULDER_MAX_HEALTH / perHit);
  for (let i = 0; i < swings; i++) {
    ctx.timestamp = { microsSinceUnixEpoch: micros(1000 * (i + 1)) }; // past the use cooldown
    useEquipped(ctx, { dirX: 1, dirY: 0 });
    if (i < swings - 1) {
      assert.equal(ctx.db.boulder.id.find(b.id)?.health, BOULDER_MAX_HEALTH - perHit * (i + 1));
      assert.equal(ctx.db.groundItem.rows().some((r: any) => r.item === "stone"), false);
    }
  }
  assert.equal(ctx.db.boulder.rows().length, 0);
  // the yield lands on the floor by the node — picking it up is a conscious E
  const stone = ctx.db.groundItem.rows().find((r: any) => r.item === "stone");
  assert.equal(stone?.qty, 1);
  assert.ok(Math.abs(stone.x - 70) <= 1 && Math.abs(stone.y - 96) <= 1, "stone by the broken boulder");
  assert.equal(ctx.db.inventory.rows().some((r: any) => r.item === "stone"), false);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.equipmentAction, "pickaxe");
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, running: p.running, path: p.path }, { dirX: 1, dirY: 0, running: true, path: "" });
});

test("an axe chips a fresh tree, and the breaking blow on a worn one grants wood", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "axe" });
  const axe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "axe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: axe.id });
  const perHit = WEAPON_DAMAGE.axe![0];
  const tr = ctx.db.tree.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: TREE_MAX_HEALTH });

  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.tree.id.find(tr.id)?.health, TREE_MAX_HEALTH - perHit); // chipped, still standing
  assert.equal(ctx.db.inventory.rows().some((r: any) => r.item === "wood"), false);

  ctx.db.tree.id.update({ ...ctx.db.tree.id.find(tr.id), health: perHit }); // worn to the last blow
  ctx.timestamp = { microsSinceUnixEpoch: micros(1000) }; // past the use cooldown
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.tree.rows().length, 0);
  assert.equal(ctx.db.groundItem.rows().find((r: any) => r.item === "wood")?.qty, 1);
  assert.equal(ctx.db.inventory.rows().some((r: any) => r.item === "wood"), false);
  assert.equal(ctx.db.player.identity.find(me).equipmentAction, "axe");
});

test("an axe only scratches a boulder — the wrong tool works at a fraction", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "axe" });
  const axe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "axe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: axe.id });
  const b = ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: BOULDER_MAX_HEALTH });
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  const chip = Math.max(1, Math.round(WEAPON_DAMAGE.axe![0] * OFF_TOOL_NODE_FACTOR));
  assert.equal(ctx.db.boulder.id.find(b.id)?.health, BOULDER_MAX_HEALTH - chip);
  assert.equal(ctx.db.inventory.rows().some((r: any) => r.item === "stone" || r.item === "wood"), false);
});

test("a full inventory can't block mining — the yield goes to the floor regardless", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  for (let i = 1; i < INVENTORY_SLOT_COUNT; i++) ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: WEAPON_DAMAGE.pickaxe![0] });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.boulder.rows().length, 0); // broken
  assert.equal(ctx.db.groundItem.rows().some((r: any) => r.item === "stone"), true); // stone on the floor
});

test("bare fists swing: unarmed damage lands and the fists impulse animates", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(other).health, PLAYER_MAX_HEALTH - UNARMED_DAMAGE[0]);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.equipmentAction, "fists");
  assert.equal(p.equippedMainHand, "");
});

test("out-of-combat regen: heals after the delay, never before, never the dead", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: micros(HEALTH_REGEN_DELAY_MS + 1000) });
  ctx.db.player.insert(playerRow(me, { online: true, health: 50, lastDamagedAt: { microsSinceUnixEpoch: micros(1000) } }));
  const fresh = id("fresh");
  ctx.db.player.insert(playerRow(fresh, { online: true, health: 50, lastDamagedAt: { microsSinceUnixEpoch: micros(HEALTH_REGEN_DELAY_MS) } }));
  const dead = id("dead");
  ctx.db.player.insert(playerRow(dead, { online: true, health: 0, dead: true, lastDamagedAt: { microsSinceUnixEpoch: micros(1000) } }));
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 0, homeY: 0, style: "", health: 10, lastDamagedAt: { microsSinceUnixEpoch: micros(1000) } });

  regenCreatures(ctx, {});

  const heal = Math.ceil(PLAYER_MAX_HEALTH * HEALTH_REGEN_FRACTION);
  assert.equal(ctx.db.player.identity.find(me).health, 50 + heal); // rested → heals
  assert.equal(ctx.db.player.identity.find(fresh).health, 50); // hit 1s ago → waits
  assert.equal(ctx.db.player.identity.find(dead).health, 0); // dead → respawn's job
  assert.equal(ctx.db.hog.rows()[0].health, 10 + Math.ceil(HOG_MAX_HEALTH * HEALTH_REGEN_FRACTION));
  assert.equal(ctx.db.creatureRegen.rows().length, 1); // re-armed while someone is online
});

test("regen never overshoots max health", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: micros(HEALTH_REGEN_DELAY_MS + 1000) });
  ctx.db.player.insert(playerRow(me, { online: true, health: PLAYER_MAX_HEALTH - 1, lastDamagedAt: { microsSinceUnixEpoch: 0n } }));
  regenCreatures(ctx, {});
  assert.equal(ctx.db.player.identity.find(me).health, PLAYER_MAX_HEALTH);
});

test("a giant Hog carries four commons' worth of health", () => {
  assert.equal(hogMaxHealth("buff"), HOG_MAX_HEALTH * 4);
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "hog", item: "dino" });
  assert.equal(ctx.db.hog.rows()[0].health, HOG_MAX_HEALTH * 4);
});

test("useEquipped damages a faced adjacent trogg with a sword", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH - WEAPON_DAMAGE.sword![0]);
  assert.equal(target.dead, false);
  assert.equal(ctx.db.player.identity.find(me).equipmentAction, "sword");
});

test("every damaging weapon wounds a creature for its own damage number", () => {
  for (const weapon of ["axe", "pickaxe", "shovel"] as const) {
    const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: weapon });
    const row = ctx.db.inventory.insert({ id: 0n, playerId: me, item: weapon, qty: 1 });
    ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: row.id });
    const other = id("other");
    ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH }));

    useEquipped(ctx, { dirX: 1, dirY: 0 });

    assert.equal(ctx.db.player.identity.find(other).health, PLAYER_MAX_HEALTH - WEAPON_DAMAGE[weapon]![0], weapon);
  }
});

test("weapon damage rolls between its floor and ceiling with the context RNG", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" }, { integerInRange: (_lo, hi) => hi as number });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(other).health, PLAYER_MAX_HEALTH - WEAPON_DAMAGE.sword![1]);
});

test("an off-tool weapon scratches a node — and only when no creature is in reach", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const tr = ctx.db.tree.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: TREE_MAX_HEALTH });

  useEquipped(ctx, { dirX: 1, dirY: 0 });
  const chip = Math.max(1, Math.round(WEAPON_DAMAGE.sword![0] * OFF_TOOL_NODE_FACTOR));
  assert.equal(ctx.db.tree.id.find(tr.id)?.health, TREE_MAX_HEALTH - chip); // whittled, barely

  // a hog steps into reach: the sword goes back to being a weapon
  const h = ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 70, y: 97, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, path: "", homeX: 0, homeY: 0, style: "", health: HOG_MAX_HEALTH });
  ctx.timestamp = { microsSinceUnixEpoch: micros(1000) }; // past the use cooldown
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.hog.id.find(h.id)?.health, HOG_MAX_HEALTH - WEAPON_DAMAGE.sword![0]);
  assert.equal(ctx.db.tree.id.find(tr.id)?.health, TREE_MAX_HEALTH - chip); // untouched this swing
});

test("the breaking hit drops the yield whatever weapon dealt it", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  ctx.db.tree.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: 1 });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.tree.rows().length, 0);
  assert.equal(ctx.db.groundItem.rows().find((r: any) => r.item === "wood")?.qty, 1);
});

test("a tool takes its gathering node over a creature in the same swing", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  const b = ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: BOULDER_MAX_HEALTH });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 97, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.boulder.id.find(b.id)?.health, BOULDER_MAX_HEALTH - WEAPON_DAMAGE.pickaxe![0]); // chipped
  assert.equal(ctx.db.player.identity.find(other).health, PLAYER_MAX_HEALTH); // spared
});

test("a sword hit at zero health kills, drops inventory, and respawns after the timer", () => {
  // fought on the generated cave's spawn plaza, which the generator keeps open
  const { ctx, me } = withPlayer({ x: 111, y: 104, equippedMainHand: "sword" }, { now: micros(1000) });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { name: "SameName", color: 1, style: 2, x: 112, y: 104, dirX: 1, dirY: 0, running: true, movedAt: { microsSinceUnixEpoch: micros(1000) }, health: WEAPON_DAMAGE.sword![0], equippedMainHand: "pickaxe", equippedMainHandInventoryId: 10n }));
  ctx.db.inventory.insert({ id: 0n, playerId: other, item: "pickaxe", qty: 1 });
  ctx.db.inventory.insert({ id: 0n, playerId: other, item: "stone", qty: 3 });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  let target = ctx.db.player.identity.find(other);
  assert.equal(target.health, 0);
  assert.equal(target.dead, true);
  assert.equal(target.equippedMainHand, "");
  assert.equal(target.equippedMainHandInventoryId, 0n);
  assert.equal(target.respawnAt.microsSinceUnixEpoch, micros(1000 + PLAYER_RESPAWN_MS));
  assert.deepEqual({ x: target.x, y: target.y, dirX: target.dirX, dirY: target.dirY, running: target.running, path: target.path }, { x: 112, y: 104, dirX: 0, dirY: 0, running: false, path: "" });
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
  assert.deepEqual({ x: target.x, y: target.y, dirX: target.dirX, dirY: target.dirY, dead: target.dead }, { x: 112, y: 104, dirX: 0, dirY: 0, dead: true });

  // Firing the scheduled respawn before the timer is due re-arms it and leaves the trogg dead.
  respawnPlayers(ctx, { timer: ctx.db.playerRespawn.rows()[0] });
  target = ctx.db.player.identity.find(other);
  assert.equal(target.dead, true);
  assert.equal(ctx.db.playerRespawn.rows().length, 1);

  ctx.timestamp = { microsSinceUnixEpoch: micros(1000 + PLAYER_RESPAWN_MS) };
  respawnPlayers(ctx, { timer: ctx.db.playerRespawn.rows()[0] });
  target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH);
  assert.equal(target.dead, false);
  assert.equal(target.respawnAt, undefined);
  assert.equal(target.name, "SameName");
  assert.equal(target.color, 1);
  assert.equal(target.style, 2);
  assert.deepEqual({ x: target.x, y: target.y }, { x: EMERGE_ARRIVAL.x, y: EMERGE_ARRIVAL.y }); // just outside the cave
});

test("useEquipped damages a faced adjacent Hog with a sword", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const h = hogAt_(ctx, 70, 96);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.hog.id.find(h.id).health, HOG_MAX_HEALTH - WEAPON_DAMAGE.sword![0]);
});

test("useEquipped damages a big 2×2 Hog on any of its footprint tiles, not just its anchor", () => {
  // Giant anchored at (6,8) covers (6,8),(7,8),(6,9),(7,9). The trogg stands at (5,9) and
  // faces the giant's lower-left body tile (6,9) — a footprint tile that is not the anchor.
  const { ctx, me } = withPlayer({ x: 69, y: 97, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const giant = hogAt_(ctx, 70, 96, { style: "buff" });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.hog.id.find(giant.id).health, HOG_MAX_HEALTH - WEAPON_DAMAGE.sword![0]);
});

test("a slain Hog drops its loot on the nearest free tile by the corpse", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" }, { now: micros(1000) });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  hogAt_(ctx, 70, 96, WEAPON_DAMAGE.sword![0]);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const drops = ctx.db.groundItem.rows();
  assert.equal(drops.length, 1);
  // the mock RNG rolls the floor of the common Hog's quill range
  assert.deepEqual({ item: drops[0].item, qty: drops[0].qty }, { item: "quill", qty: hogLoot("")[0]!.min });
  const corpse = ctx.db.hog.rows()[0];
  assert.ok(Math.abs(drops[0].x - corpse.x) <= 1 && Math.abs(drops[0].y - corpse.y) <= 1, "loot beside the corpse");
});

test("a slain giant sheds a giant's share of quills", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" }, { now: micros(1000) });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  hogAt_(ctx, 70, 96, { style: "buff", health: WEAPON_DAMAGE.sword![0] });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.groundItem.rows()[0]?.qty, hogLoot("buff")[0]!.min);
});

test("loot respects the per-zone ground-item cap", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" }, { now: micros(1000) });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  for (let i = 0; i < MAX_GROUND_ITEMS_PER_ZONE; i++) ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "stone", x: 65, y: 89, qty: 1 });
  hogAt_(ctx, 70, 96, WEAPON_DAMAGE.sword![0]);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.groundItem.rows().length, MAX_GROUND_ITEMS_PER_ZONE); // full zone drops nothing extra
});

test("a killed Hog becomes a settled corpse, untargetable, reaped after NPC_CORPSE_MS", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" }, { now: micros(1000) });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  hogAt_(ctx, 70, 96, WEAPON_DAMAGE.sword![0]);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const corpse = ctx.db.hog.rows()[0];
  assert.deepEqual({ health: corpse.health, dirX: corpse.dirX, dirY: corpse.dirY }, { health: 0, dirX: 0, dirY: 0 });

  // a second swing finds nothing — corpses are not targets
  ctx.timestamp = { microsSinceUnixEpoch: micros(2000) };
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.hog.rows()[0].health, 0);

  // the regen sweep leaves a fresh corpse alone, then reaps it after NPC_CORPSE_MS
  regenCreatures(ctx, {});
  assert.equal(ctx.db.hog.rows().length, 1);
  ctx.timestamp = { microsSinceUnixEpoch: micros(1000 + NPC_CORPSE_MS) };
  regenCreatures(ctx, {});
  assert.equal(ctx.db.hog.rows().length, 0);
});

test("useEquipped throws a carried boulder into a trogg and lands it past the target", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder", equippedMainHand: "" });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 71, y: 96, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH - THROWN_OBJECT_DAMAGE);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 72, y: 96 });
});

test("useEquipped throws a carried Hog into a trogg", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "hog", equippedMainHand: "" });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(other).health, PLAYER_MAX_HEALTH - THROWN_OBJECT_DAMAGE);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const h = ctx.db.hog.rows()[0];
  assert.deepEqual({ x: h.x, y: h.y, dirX: h.dirX, dirY: h.dirY }, { x: 71, y: 96, dirX: 0, dirY: 0 });
});

test("useEquipped throws a carried boulder into a Hog", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder", equippedMainHand: "" });
  const h = hogAt_(ctx, 71, 96);

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.hog.id.find(h.id).health, HOG_MAX_HEALTH - THROWN_OBJECT_DAMAGE);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 72, y: 96 });
});

test("useEquipped throws a carried object to max range when it hits no trogg", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder", equippedMainHand: "" });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 73, y: 96 });
});

test("useEquipped throws a carried object along a diagonal aim, not the nearest cardinal", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder", equippedMainHand: "" });

  useEquipped(ctx, { dirX: 1, dirY: 1 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  // travelled on both axes — a cardinal-snapped throw would leave y at 96
  assert.ok(b.x > 69 && b.y > 96, `expected a diagonal landing, got (${b.x}, ${b.y})`);
});

test("a thrown Hog is settled in place and the wander leaves it alone until it lands", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "hog", equippedMainHand: "", online: true }, { now: 0n, random: 0.99, integerInRange: (lo) => lo });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const thrown = ctx.db.hog.rows()[0];
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(thrown.dirX, 0); // lands at rest
  assert.ok(Number(thrown.landingAt.microsSinceUnixEpoch) > 0, "landingAt set into the future");

  // the wander runs at the same instant (still in flight): the Hog must not move
  wanderHogs(ctx, {});
  const after = ctx.db.hog.id.find(thrown.id);
  assert.deepEqual({ x: after.x, y: after.y, dirX: after.dirX, dirY: after.dirY }, { x: thrown.x, y: thrown.y, dirX: 0, dirY: 0 });
});

test("interact prioritizes the faced pickup when several entities are adjacent", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "" });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 69, y: 95 });
  hogAt_(ctx, 70, 96);
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "hog");
  assert.equal(ctx.db.hog.rows().length, 0);
  assert.equal(ctx.db.boulder.rows().length, 1);
});

test("interact prioritizes a faced ground item over other adjacent pickups", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "" });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 69, y: 95 });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "sword", x: 70, y: 96 });
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
    ctx.db.ghostHaunt.insert({ id: 0n, zoneId: ZONE, x: 65, y: 89, createdAt: { microsSinceUnixEpoch: 0n } });
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
  const zone = getZone(ZONE)!;
  const cave = getZone(birthZoneFor(me.toHexString()))!;
  // world boulders, plus the newborn's private instance rubble in its own zone
  assert.equal(ctx.db.boulder.rows().length, zone.boulders.length + cave.cells[0]!.corridor.length);
  assert.equal(ctx.db.hog.rows().length, zone.hogs.length + zone.bigHogs.length);
  // the world's starter rack, plus the instance's pickaxe
  assert.equal(ctx.db.groundItem.rows().length, zone.items.length + 1);
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
  ctx.db.player.insert(playerRow(me, { online: false, x: 69, y: 96, name: "Keepme" }));
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
  ctx.db.player.insert(playerRow(me, { online: true, x: 69, y: 96, dirX: 1, dirY: 0, running: true, movedAt: { microsSinceUnixEpoch: 0n } }));
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
  ctx.db.player.insert(playerRow(me, { online: true, x: 69, y: 96, dirX: 1, dirY: 0, carrying: "boulder" }));
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
  assert.deepEqual({ x: p.x, y: p.y }, { x: 112, y: 104 }); // the world spawn (spawnAt)
});

test("disconnecting drops the carried entity into the world and marks the trogg offline", () => {
  const me = id("leaver");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { carrying: "boulder", x: 69, y: 96, online: true }));
  onDisconnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.online, false);
  assert.equal(p.carrying, "");
  assert.equal(ctx.db.boulder.rows().length, 1);
});

// --- Click-to-move pathfinding ---

test("moveTo stores a cardinal route toward a reachable tile", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  moveTo(ctx, { x: 72, y: 96, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.equal(parsePath(p.path).at(-1)?.x, 72); // route ends at the target column
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, faceX: p.faceX, faceY: p.faceY }, { dirX: 1, dirY: 0, faceX: 1, faceY: 0 });
});

// --- Interacting: put-down, the cap on drop, and Hog pickup ---

test("interact puts a carried boulder down on the faced tile", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder" });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(ctx.db.boulder.rows().length, 1);
});

test("a drop is refused at the entity cap, so the trogg keeps carrying", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "hog" });
  for (let i = 0; i < MAX_HOGS_PER_ZONE; i++) hogAt_(ctx, 65, 89);
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "hog"); // still carrying
  assert.equal(ctx.db.hog.rows().length, MAX_HOGS_PER_ZONE); // no overflow
});

test("interact picks up a Hog on the faced tile", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  hogAt_(ctx, 70, 96);
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.hog.rows().length, 0);
  assert.equal(ctx.db.player.identity.find(me).carrying, "hog");
});

test("interact preserves a Hog's style while carried and after put-down", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  hogAt_(ctx, 70, 96, "ember");

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
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const hog = hogAt_(ctx, 70, 96);

  interact(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(me).carryingStyle, hogStyleFor(hog.id.toString()));
});

// --- Reset commands restore the registry layout ---

test("resetBoulders restores the zone's registry boulder layout", () => {
  const { ctx } = withPlayer({});
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 65, y: 89 }); // a shoved/extra boulder
  resetBoulders(ctx);
  const reg = getZone(ZONE)!.boulders;
  const keys = new Set(ctx.db.boulder.rows().map((b: any) => `${b.x},${b.y}`));
  assert.deepEqual(keys, new Set(reg.map((c) => `${c.x},${c.y}`)));
});

test("resetHogs restores the zone's registry Hog population", () => {
  const { ctx } = withPlayer({});
  hogAt_(ctx, 65, 89);
  hogAt_(ctx, 66, 90);
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

// --- World healing (regenerated maps under a live database) ---

test("onConnect wipes and reseeds rows stranded in rock by a map regen", () => {
  const me = id("healer");
  const ctx = makeCtx({ sender: me });
  // a boulder from an old layout, now inside the new map's rock at (0, 0)
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 0, y: 0 });
  ctx.db.hog.insert({ id: 0n, zoneId: ZONE, x: 0, y: 1, dirX: 0, dirY: 0, movedAt: { microsSinceUnixEpoch: 0n }, style: "", health: 60 });
  onConnect(ctx);
  const zone = getZone(ZONE)!;
  for (const b of ctx.db.boulder.zoneId.filter(ZONE)) {
    assert.ok(isWalkable(zone, b.x, b.y), `reseeded boulder at ${b.x},${b.y} is in rock`);
  }
  assert.ok(ctx.db.boulder.zoneId.filter(ZONE).length > 0);
  assert.ok(ctx.db.hog.rows().every((h: any) => isWalkable(zone, Math.round(h.x), Math.round(h.y))));
});

test("onConnect leaves healthy world rows alone", () => {
  const me = id("keeper");
  const ctx = makeCtx({ sender: me });
  const zone = getZone(ZONE)!;
  const seed = zone.boulders[0]!;
  const kept = ctx.db.boulder.insert({ id: 7n, zoneId: ZONE, x: seed.x, y: seed.y });
  onConnect(ctx);
  assert.ok(ctx.db.boulder.rows().some((b: any) => b.id === kept.id));
});

// --- Cheats (Commands panel debug tools) ---

test("setCheats clamps speed to the fixed multiplier and settles motion", () => {
  const { ctx, me } = withPlayer({ x: 108, y: 105 });
  move(ctx, { dirX: 1000, dirY: 0, running: false });
  setCheats(ctx, { speed: 99, fly: true, noclip: true, invulnerable: true });
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.cheatSpeed, CHEAT_SPEED_MULTIPLIER);
  assert.equal(p.cheatFly, true);
  assert.equal(p.cheatInvulnerable, true);
  assert.equal(p.cheatNoclip, true);
  assert.equal(p.dirX, 0); // a rules change never replays motion history
  assert.equal(p.dirY, 0);
});

test("setCheats off resets every cheat", () => {
  const { ctx, me } = withPlayer({ x: 108, y: 105, cheatSpeed: CHEAT_SPEED_MULTIPLIER, cheatFly: true, cheatInvulnerable: true, cheatNoclip: true });
  setCheats(ctx, { speed: 1, fly: false, noclip: false, invulnerable: false });
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.cheatSpeed, 1);
  assert.equal(p.cheatFly, false);
  assert.equal(p.cheatInvulnerable, false);
  assert.equal(p.cheatNoclip, false);
});

test("switching noclip off inside geometry settles onto walkable ground", () => {
  const zone = getZone(ZONE)!;
  // park the flyer mid-air over unwalkable rock beside real ground (the map
  // corner is rock for further than the landing search reaches)
  let wall: { x: number; y: number } | undefined;
  for (let y = 1; y < zone.height - 1 && !wall; y++) {
    for (let x = 1; x < zone.width - 1 && !wall; x++) {
      if (!isWalkable(zone, x, y) && isWalkable(zone, x + 1, y)) wall = { x, y };
    }
  }
  const { ctx, me } = withPlayer({ x: wall!.x, y: wall!.y, cheatNoclip: true });
  setCheats(ctx, { speed: 1, fly: false, noclip: false, invulnerable: false });
  const p = ctx.db.player.identity.find(me);
  assert.ok(isWalkable(zone, Math.round(p.x), Math.round(p.y)), `landed at ${p.x},${p.y}`);
});

test("the speed cheat multiplies projected distance", () => {
  const zone = getZone(ZONE)!;
  const motion = { x: 108, y: 105, dirX: 1000, dirY: 0, cheatSpeed: CHEAT_SPEED_MULTIPLIER, cheatNoclip: true };
  const at = projectMotion(motion, 1_000, zoneBounds(zone));
  assert.ok(Math.abs(at.x - 108 - MOVE_SPEED_TILES_PER_SEC * CHEAT_SPEED_MULTIPLIER) < 1e-6, `moved to ${at.x}`);
});

test("noclipped and airborne troggs project through walls, a normal one clamps", () => {
  const bounds = { width: 20, height: 20, isWalkable: (x: number) => x < 5 };
  const grounded = projectMotion({ x: 3, y: 3, dirX: 1000, dirY: 0 }, 5_000, bounds);
  assert.ok(grounded.x < 5, `grounded clamped at ${grounded.x}`);
  const noclip = projectMotion({ x: 3, y: 3, dirX: 1000, dirY: 0, cheatNoclip: true }, 2_000, bounds);
  assert.ok(Math.abs(noclip.x - 11) < 1e-6, `passed through to ${noclip.x}`);
  const airborne = projectMotion({ x: 3, y: 3, dirX: 1000, dirY: 0, cheatFly: true }, 2_000, bounds);
  assert.ok(Math.abs(airborne.x - 11) < 1e-6, `flew over to ${airborne.x}`);
});

test("an invulnerable trogg takes no damage from a swing", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH, cheatInvulnerable: true }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH);
  assert.equal(target.dead, false);
});

test("setLift stores a sign-clamped vertical intent for a flyer only", () => {
  const { ctx, me } = withPlayer({ x: 108, y: 105 });
  setLift(ctx, { dirZ: 5 });
  assert.equal(ctx.db.player.identity.find(me).dirZ, 0); // grounded: ignored
  setCheats(ctx, { speed: 1, fly: true, noclip: false, invulnerable: false });
  setLift(ctx, { dirZ: 5 });
  assert.equal(ctx.db.player.identity.find(me).dirZ, 1);
  setLift(ctx, { dirZ: -9 });
  assert.equal(ctx.db.player.identity.find(me).dirZ, -1);
});

test("altitude derives linearly from the lift intent and clamps to the ceiling", () => {
  const zone = getZone(ZONE)!;
  const bounds = zoneBounds(zone);
  const climb = projectMotionState({ x: 108, y: 105, dirX: 0, dirY: 0, cheatFly: true, z: 0, dirZ: 1 }, 1_000, bounds);
  assert.ok(Math.abs(climb.z - FLY_VERTICAL_TILES_PER_SEC) < 1e-6, `z ${climb.z}`);
  const capped = projectMotionState({ x: 108, y: 105, dirX: 0, dirY: 0, cheatFly: true, z: 0, dirZ: 1 }, 60_000, bounds);
  assert.equal(capped.z, FLY_MAX_HEIGHT);
  const grounded = projectMotionState({ x: 108, y: 105, dirX: 0, dirY: 0, cheatFly: true, z: 3, dirZ: -1 }, 60_000, bounds);
  assert.equal(grounded.z, 0);
});

test("a flyer clears obstacles below its altitude and bumps into taller rock", () => {
  const zone = getZone(ZONE)!;
  // a dynamic obstacle (tree/boulder class): passable above FLY_CLEAR_OBSTACLE
  const occupied = zoneBounds(zone, (x, y) => x === 110 && y === 105);
  const low = projectMotion({ x: 108, y: 105, dirX: 1000, dirY: 0, cheatFly: true, z: 1, dirZ: 0 }, 3_000, occupied);
  assert.ok(low.x < 110, `low flyer clamped at ${low.x}`);
  const high = projectMotion({ x: 108, y: 105, dirX: 1000, dirY: 0, cheatFly: true, z: FLY_CLEAR_OBSTACLE + 1, dirZ: 0 }, 3_000, occupied);
  assert.ok(high.x > 110, `high flyer passed to ${high.x}`);
  // rock clears at its rendered per-tile height — just below bumps, just above passes
  let wall: { x: number; y: number } | undefined;
  for (let y = 1; y < zone.height - 1 && !wall; y++) {
    for (let x = 1; x < zone.width - 1 && !wall; x++) {
      if (!isWalkable(zone, x, y) && tileGlyph(zone, x, y) !== DEEP_WATER_TILE && isWalkable(zone, x - 1, y)) wall = { x, y };
    }
  }
  const bounds = zoneBounds(zone);
  const summit = rockHeightAt(zone, wall!.x, wall!.y);
  const below = projectMotion({ x: wall!.x - 1, y: wall!.y, dirX: 1000, dirY: 0, cheatFly: true, z: summit - 0.05, dirZ: 0 }, 1_000, bounds);
  assert.ok(below.x < wall!.x, `flyer under the rock top clamped at ${below.x} before wall ${wall!.x}`);
  const above = projectMotion({ x: wall!.x - 1, y: wall!.y, dirX: 1000, dirY: 0, cheatFly: true, z: summit + 0.05, dirZ: 0 }, 1_000, bounds);
  assert.ok(above.x >= wall!.x, `flyer over the rock top passed to ${above.x}`);
});

test("healSelf restores a living trogg to full health", () => {
  const { ctx, me } = withPlayer({ x: 108, y: 105, health: 7 });
  healSelf(ctx);
  assert.equal(ctx.db.player.identity.find(me).health, PLAYER_MAX_HEALTH);
});

test("rescue lands a stuck trogg on standable ground", () => {
  const zone = getZone(ZONE)!;
  let wall: { x: number; y: number } | undefined;
  for (let y = 1; y < zone.height - 1 && !wall; y++) {
    for (let x = 1; x < zone.width - 1 && !wall; x++) {
      if (!isWalkable(zone, x, y) && isWalkable(zone, x + 1, y)) wall = { x, y };
    }
  }
  const { ctx, me } = withPlayer({ x: wall!.x, y: wall!.y, cheatNoclip: true, z: 6, cheatFly: true });
  rescue(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.ok(isWalkable(zone, Math.round(p.x), Math.round(p.y)), `rescued to ${p.x},${p.y}`);
  assert.equal(p.z, 0);
});

test("setSky pins the shared day phase for everyone and live releases it", () => {
  const { ctx } = withPlayer({ x: 108, y: 105 });
  setSky(ctx, { phase: 1.25, locked: true });
  let state = ctx.db.worldState.id.find(0);
  assert.equal(state.skyLocked, true);
  assert.ok(Math.abs(state.skyPhase - 0.25) < 1e-9); // wrapped into [0, 1)
  setSky(ctx, { phase: 0, locked: false });
  state = ctx.db.worldState.id.find(0);
  assert.equal(state.skyLocked, false);
});

// --- The instanced birth cave (GDD "Onboarding: the Warren") ---

test("a newborn is born alone in its own instanced birth cave", () => {
  const me = id("newborn");
  const ctx = makeCtx({ sender: me });
  onConnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.ok(isBirthZone(p.zoneId));
  assert.equal(p.zoneId, birthZoneFor(me.toHexString()));
  const cave = getZone(p.zoneId)!;
  assert.equal(p.x, cave.spawn!.x);
  assert.equal(p.y, cave.spawn!.y);
  assert.equal(p.faceY, -1);
  const rubble = ctx.db.boulder.zoneId.filter(p.zoneId);
  assert.equal(rubble.length, cave.cells[0]!.corridor.length);
  const pick = ctx.db.groundItem.zoneId.filter(p.zoneId)[0];
  assert.equal(pick?.item, "pickaxe");
});

test("two newborns never share a cave", () => {
  const a = id("baby-a");
  const b = id("baby-b");
  const ctx = makeCtx({ sender: a });
  onConnect(ctx);
  onConnect({ ...ctx, sender: b });
  const pa = ctx.db.player.identity.find(a);
  const pb = ctx.db.player.identity.find(b);
  assert.notEqual(pa.zoneId, pb.zoneId);
  assert.equal(ctx.db.boulder.zoneId.filter(pa.zoneId).length, getZone(pa.zoneId)!.cells[0]!.corridor.length);
  assert.equal(ctx.db.boulder.zoneId.filter(pb.zoneId).length, getZone(pb.zoneId)!.cells[0]!.corridor.length);
});

test("walking onto the exit landing emerges into the world; the cave persists", () => {
  const me = id("emerging");
  const ctx = makeCtx({ sender: me });
  onConnect(ctx);
  const birthZone = birthZoneFor(me.toHexString());
  const cave = getZone(birthZone)!;
  const rubble = ctx.db.boulder.zoneId.filter(birthZone).length;
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), x: cave.exit!.x, y: cave.exit!.y + 1 });
  emerge(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.zoneId, ZONE);
  assert.equal(p.x, EMERGE_ARRIVAL.x);
  assert.equal(p.y, EMERGE_ARRIVAL.y);
  // your cave stays exactly as you left it — enterCave leads back
  assert.equal(ctx.db.boulder.zoneId.filter(birthZone).length, rubble);
});

test("pushing into the alcove's deep end descends into your own cave", () => {
  const me = id("returning");
  const ctx = makeCtx({ sender: me });
  onConnect(ctx);
  const birthZone = birthZoneFor(me.toHexString());
  const cave = getZone(birthZone)!;
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), x: cave.exit!.x, y: cave.exit!.y + 1 });
  emerge(ctx);
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), x: CAVE_DOOR.x, y: CAVE_DOOR.y });
  enterCave(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.zoneId, birthZone);
  assert.equal(p.x, cave.exit!.x);
  assert.equal(p.y, cave.exit!.y + 3); // below the neck, clear of the emerge threshold
});

test("enterCave is refused away from the alcove's deep end", () => {
  const me = id("wanderer");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { x: 112, y: 104, zoneId: ZONE }));
  enterCave(ctx);
  assert.equal(ctx.db.player.identity.find(me).zoneId, ZONE);
});

test("emerge is refused away from the exit — the dig cannot be skipped", () => {
  const me = id("cheater");
  const ctx = makeCtx({ sender: me });
  onConnect(ctx);
  emerge(ctx); // still standing in the sealed birth cell
  const p = ctx.db.player.identity.find(me);
  assert.ok(isBirthZone(p.zoneId));
});

test("a returning mid-dig trogg resumes its own cave exactly as it left it", () => {
  const me = id("sleeper");
  const ctx = makeCtx({ sender: me });
  onConnect(ctx);
  const birthZone = birthZoneFor(me.toHexString());
  // mined one rock, then logged off
  const first = ctx.db.boulder.zoneId.filter(birthZone)[0];
  ctx.db.boulder.id.delete(first.id);
  const remaining = ctx.db.boulder.zoneId.filter(birthZone).length;
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), online: false });
  ctx.db.playerConnection.connectionId.delete(ctx.connectionId);
  onConnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.zoneId, birthZone);
  assert.equal(ctx.db.boulder.zoneId.filter(birthZone).length, remaining);
});
