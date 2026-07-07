import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAT_HISTORY_MAX,
  CLAIM_CODE_TTL_MS,
  GHOST_HAUNT_HISTORY_MAX,
  getZone,
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
  parsePath,
  PLAYER_MAX_HEALTH,
  PLAYER_RESPAWN_MS,
  SHIELD_BLOCK_FRACTION,
  SPACETIMEAUTH_ISSUER,
  WEAPON_DAMAGE,
  BOULDER_MAX_HEALTH,
  OFF_TOOL_NODE_FACTOR,
  TREE_MAX_HEALTH,
  THROWN_OBJECT_DAMAGE,
  UNARMED_DAMAGE,
  HEALTH_REGEN_DELAY_MS,
  HEALTH_REGEN_FRACTION,
  STOCKPILE_CAP,
  BRAZIER_UPKEEP_ITEM,
  BRAZIER_UPKEEP_RATE,
  BRAZIER_LIT_RADIUS,
  FIRST_FIRE_LIT_RADIUS,
  AFK_CHARGE_MAX,
  AFK_CHARGE_ACCRUAL_RATE,
  AFK_CHARGE_DECAY_RATE,
  AFK_GATHER_DAMAGE,
  AFK_UNLOCK_XP,
  AFK_HIDE_AFTER_MS,
  BRAZIER_CLAIM_STONE_COST,
  NIGHT_SPAWN_MIN_PLAYER_DIST,
  DARK_CREATURE_LEASH_RANGE,
  NPC_CORPSE_MS,
  upkeepReserve,
  TORCH_BURN_MS,
  AFK_WANDER_TICK_MS,
  GATHER_XP,
  COMBAT_XP_PER_DAMAGE,
  DARK_CREATURE_AGGRO_RANGE,
  DARK_CREATURES,
  MAX_DARK_CREATURES_PER_ZONE,
  NPC_CORPSE_MS,
  isRevealed,
  neighborsOf,
  penumbraOf,
  regionAt,
  capitalOf,
  regionSeeds,
  regionSlug,
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
  setCheats,
  setLift,
  setSky,
  healSelf,
  rescue,
  respawnPlayers,
  regenCreatures,
  brazierUpkeep,
  wanderPresence,
  respawnNodes,
  spawn,
  resetDarkCreatures,
  startClaim,
  useEquipped,
  craftItem,
  revealNextRegion,
  jumpRegions,
  resetFrontier,
} from "../spacetimedb/src/index.ts";
import { darkCreatureRow, id, makeCtx, playerRow, revealedRegionRow } from "./spacetime.ts";

const ZONE = "world";
const micros = (ms: number) => BigInt(ms) * 1000n;

/** Put a trogg past the AFK eligibility gate (GDD "Presence") so its offline instinct runs. */
const afkEligible = (ctx: any, playerId: any) => ctx.db.skills.insert({ id: 0n, playerId, skill: "mining", xp: AFK_UNLOCK_XP });

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
  const { ctx, me } = withPlayer({ x: 33, y: 36, dirX: 0, dirY: 0 }); // the open hearth plaza
  move(ctx, { dirX: 966, dirY: -259, running: false }); // ~15° above east
  const p = ctx.db.player.identity.find(me);
  const zone = getZone(ZONE)!;
  const at = projectMotion(p, 1_000, zoneBounds(zone));
  const dist = Math.hypot(at.x - 33, at.y - 36);
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

test("mining takes swings: each hit chips the boulder, the breaking hit deposits stone into the stockpile", () => {
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
      assert.equal(ctx.db.stockpile.item.find("stone"), undefined);
    }
  }
  assert.equal(ctx.db.boulder.rows().length, 0);
  // the yield deposits straight into the shared stockpile — never a personal stash
  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, 1);
  assert.equal(ctx.db.groundItem.rows().some((r: any) => r.item === "stone"), false);
  assert.equal(ctx.db.inventory.rows().some((r: any) => r.item === "stone"), false);
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.equipmentAction, "pickaxe");
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY, running: p.running, path: p.path }, { dirX: 1, dirY: 0, running: true, path: "" });
});

test("an axe chips a fresh tree, and the breaking blow on a worn one deposits wood into the stockpile", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "axe" });
  const axe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "axe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: axe.id });
  const perHit = WEAPON_DAMAGE.axe![0];
  const tr = ctx.db.tree.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: TREE_MAX_HEALTH });

  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.tree.id.find(tr.id)?.health, TREE_MAX_HEALTH - perHit); // chipped, still standing
  assert.equal(ctx.db.stockpile.item.find("wood"), undefined);

  ctx.db.tree.id.update({ ...ctx.db.tree.id.find(tr.id), health: perHit }); // worn to the last blow
  ctx.timestamp = { microsSinceUnixEpoch: micros(1000) }; // past the use cooldown
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.tree.rows().length, 0);
  assert.equal(ctx.db.stockpile.item.find("wood")?.qty, 1);
  assert.equal(ctx.db.inventory.rows().some((r: any) => r.item === "wood"), false);
  assert.equal(ctx.db.player.identity.find(me).equipmentAction, "axe");
});

test("the stockpile caps deposits at STOCKPILE_CAP", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  ctx.db.stockpile.insert({ item: "stone", qty: STOCKPILE_CAP });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: WEAPON_DAMAGE.pickaxe![0] });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.boulder.rows().length, 0); // still breaks
  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, STOCKPILE_CAP); // absorbs no more than the cap
});

test("an axe only scratches a boulder — the wrong tool works at a fraction", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "axe" });
  const axe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "axe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: axe.id });
  const b = ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: BOULDER_MAX_HEALTH });
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  const chip = Math.max(1, Math.round(WEAPON_DAMAGE.axe![0] * OFF_TOOL_NODE_FACTOR));
  assert.equal(ctx.db.boulder.id.find(b.id)?.health, BOULDER_MAX_HEALTH - chip);
  assert.equal(ctx.db.stockpile.rows().length, 0);
});

test("a full inventory can't block mining — the yield deposits into the stockpile regardless", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  for (let i = 1; i < INVENTORY_SLOT_COUNT; i++) ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: WEAPON_DAMAGE.pickaxe![0] });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.boulder.rows().length, 0); // broken
  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, 1); // deposited into the stockpile
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

  regenCreatures(ctx, {});

  const heal = Math.ceil(PLAYER_MAX_HEALTH * HEALTH_REGEN_FRACTION);
  assert.equal(ctx.db.player.identity.find(me).health, 50 + heal); // rested → heals
  assert.equal(ctx.db.player.identity.find(fresh).health, 50); // hit 1s ago → waits
  assert.equal(ctx.db.player.identity.find(dead).health, 0); // dead → respawn's job
  assert.equal(ctx.db.creatureRegen.rows().length, 1); // re-armed while someone is online
});

test("regen never overshoots max health", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me, now: micros(HEALTH_REGEN_DELAY_MS + 1000) });
  ctx.db.player.insert(playerRow(me, { online: true, health: PLAYER_MAX_HEALTH - 1, lastDamagedAt: { microsSinceUnixEpoch: 0n } }));
  regenCreatures(ctx, {});
  assert.equal(ctx.db.player.identity.find(me).health, PLAYER_MAX_HEALTH);
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

test("a shield in the off hand blocks a fraction of melee damage taken", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH, equippedOffHand: "shield" }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const dealt = Math.round(WEAPON_DAMAGE.sword![0] * (1 - SHIELD_BLOCK_FRACTION));
  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH - dealt);
});

test("a shield also blocks a fraction of thrown damage taken", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder", equippedMainHand: "" });
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 96, health: PLAYER_MAX_HEALTH, equippedOffHand: "shield" }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const dealt = Math.round(THROWN_OBJECT_DAMAGE * (1 - SHIELD_BLOCK_FRACTION));
  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH - dealt);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
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

  // a trogg steps into reach: the sword goes back to being a weapon
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 70, y: 97, health: PLAYER_MAX_HEALTH }));
  ctx.timestamp = { microsSinceUnixEpoch: micros(1000) }; // past the use cooldown
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(other).health, PLAYER_MAX_HEALTH - WEAPON_DAMAGE.sword![0]);
  assert.equal(ctx.db.tree.id.find(tr.id)?.health, TREE_MAX_HEALTH - chip); // untouched this swing
});

test("the breaking hit deposits the yield into the stockpile whatever weapon dealt it", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  ctx.db.tree.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: 1 });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.tree.rows().length, 0);
  assert.equal(ctx.db.stockpile.item.find("wood")?.qty, 1);
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

test("useEquipped throws a carried boulder into a trogg and lands it past the target", () => {
  const { ctx, me } = withPlayer({ x: 31, y: 35, carrying: "boulder", equippedMainHand: "" }); // the open hearth plaza
  const other = id("other");
  ctx.db.player.insert(playerRow(other, { x: 33, y: 35, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const target = ctx.db.player.identity.find(other);
  assert.equal(target.health, PLAYER_MAX_HEALTH - THROWN_OBJECT_DAMAGE);
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 34, y: 35 });
});

test("useEquipped throws a carried object to max range when it hits no trogg", () => {
  const { ctx, me } = withPlayer({ x: 31, y: 35, carrying: "boulder", equippedMainHand: "" }); // the open hearth plaza

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual({ x: b.x, y: b.y }, { x: 35, y: 35 });
});

test("useEquipped throws a carried object along a diagonal aim, not the nearest cardinal", () => {
  const { ctx, me } = withPlayer({ x: 33, y: 33, carrying: "boulder", equippedMainHand: "" }); // the open hearth plaza

  useEquipped(ctx, { dirX: 1, dirY: 1 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  const b = ctx.db.boulder.rows()[0];
  // travelled on both axes — a cardinal-snapped throw would leave y at 33
  assert.ok(b.x > 33 && b.y > 33, `expected a diagonal landing, got (${b.x}, ${b.y})`);
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
  // world registry boulders plus the newborn's private instance rubble — and
  // healRegionPopulations backfills the revealed block's region-seeded rows,
  // so the registry layout is a floor, not the whole set
  assert.ok(ctx.db.boulder.rows().length >= zone.boulders.length + cave.cells[0]!.corridor.length);
  const boulderKeys = new Set(ctx.db.boulder.rows().filter((b: any) => b.zoneId === ZONE).map((b: any) => `${b.x},${b.y}`));
  for (const c of zone.boulders) assert.ok(boulderKeys.has(`${c.x},${c.y}`), `registry boulder at ${c.x},${c.y}`);
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

test("a returning trogg embedded in a wall is nudged to nearby safe ground", () => {
  const me = id("stuck");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { online: false, x: 33, y: 55 })); // the alcove ring — guaranteed rock
  onConnect(ctx);
  const p = ctx.db.player.identity.find(me);
  const zone = getZone(ZONE)!;
  assert.ok(isWalkable(zone, Math.round(p.x), Math.round(p.y)), `resumed at ${p.x},${p.y}`);
});

test("disconnecting drops the carried entity into the world and marks the trogg offline", () => {
  const me = id("leaver");
  const ctx = makeCtx({ sender: me });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  // Charged and already on lit ground, so it goes afk in place rather than
  // being recalled (Phase 4 "Presence" changes what happens off lit ground —
  // see the disconnect-recall tests below).
  ctx.db.player.insert(playerRow(me, { carrying: "boulder", x: 69, y: 96, online: true, kindlingCharge: 5, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
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

// --- Interacting: put-down and the cap on drop ---

test("interact puts a carried boulder down on the faced tile", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder" });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(ctx.db.boulder.rows().length, 1);
});

test("a drop is refused at the entity cap, so the trogg keeps carrying", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, carrying: "boulder" });
  for (let i = 0; i < MAX_BOULDERS_PER_ZONE; i++) ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 65, y: 89 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(me).carrying, "boulder"); // still carrying
  assert.equal(ctx.db.boulder.rows().length, MAX_BOULDERS_PER_ZONE); // no overflow
});

// --- Reset commands restore the registry layout ---

test("resetBoulders restores the registry layout and heals region-seeded ground", () => {
  const { ctx } = withPlayer({});
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 65, y: 89 }); // a shoved/extra boulder
  resetBoulders(ctx);
  const reg = getZone(ZONE)!.boulders;
  const keys = new Set(ctx.db.boulder.rows().map((b: any) => `${b.x},${b.y}`));
  for (const c of reg) assert.ok(keys.has(`${c.x},${c.y}`), `registry boulder at ${c.x},${c.y}`);
  assert.equal(keys.has("65,89"), false); // the shoved row is gone
  // and the reset can no longer strip revealed regions bare — their seeds return
  assert.ok(ctx.db.boulder.rows().length > reg.length);
});

// --- Braziers and territory ---

test("onConnect seeds the First Fire as one eternal, always-lit brazier at the zone spawn", () => {
  const me = id("newguest");
  const ctx = makeCtx({ sender: me });
  onConnect(ctx);
  const zone = getZone(ZONE)!;
  const spawn = zone.spawn ?? { x: Math.floor(zone.width / 2), y: Math.floor(zone.height / 2) };
  const braziers = ctx.db.brazier.rows();
  assert.equal(braziers.length, 1);
  assert.deepEqual(
    { x: braziers[0].x, y: braziers[0].y, radius: braziers[0].radius, lit: braziers[0].lit, isEternal: braziers[0].isEternal },
    { x: spawn.x, y: spawn.y, radius: FIRST_FIRE_LIT_RADIUS, lit: true, isEternal: true },
  );

  // idempotent: a second guest connecting to the same world doesn't seed a duplicate First Fire
  (ctx as any).sender = id("anotherguest");
  onConnect(ctx);
  assert.equal(ctx.db.brazier.rows().filter((b: any) => b.zoneId === ZONE).length, 1);
});

test("brazierUpkeep pays every lit brazier when the stockpile can cover it", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 0, y: 0, radius: FIRST_FIRE_LIT_RADIUS, lit: true, isEternal: true });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 10, y: 0, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 20, y: 0, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.stockpile.insert({ item: BRAZIER_UPKEEP_ITEM, qty: 10 });

  brazierUpkeep(ctx, {});

  assert.equal(ctx.db.brazier.rows().every((b: any) => b.lit), true);
  assert.equal(ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM)?.qty, 10 - 2 * BRAZIER_UPKEEP_RATE);
  assert.equal(ctx.db.brazierUpkeepTimer.rows().length, 1); // re-armed while someone is online
});

test("brazierUpkeep gutters the region furthest (by hop-depth) from the Hearth first when unpaid", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { online: true }));
  const firstFire = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 0, y: 0, radius: FIRST_FIRE_LIT_RADIUS, lit: true, isEternal: true });
  // emberrift is one hop from the Hearth; dustworks is two.
  const near = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 149, y: 72, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  const far = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 83, y: 143, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.stockpile.insert({ item: BRAZIER_UPKEEP_ITEM, qty: BRAZIER_UPKEEP_RATE }); // affords only one

  brazierUpkeep(ctx, {});

  assert.equal(ctx.db.brazier.id.find(firstFire.id)?.lit, true); // the First Fire is never billed
  assert.equal(ctx.db.brazier.id.find(near.id)?.lit, true); // shallower region, kept lit
  assert.equal(ctx.db.brazier.id.find(far.id)?.lit, false); // deepest region, gutters first
  assert.equal(ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM)?.qty, 0);
});

test("brazierUpkeep never bills or gutters the First Fire, even with an empty stockpile", () => {
  const me = id("watcher");
  const ctx = makeCtx({ sender: me });
  ctx.db.player.insert(playerRow(me, { online: true }));
  const firstFire = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 0, y: 0, radius: FIRST_FIRE_LIT_RADIUS, lit: true, isEternal: true });

  brazierUpkeep(ctx, {});

  assert.equal(ctx.db.brazier.id.find(firstFire.id)?.lit, true);
  assert.equal(ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM), undefined); // never touched
});

// --- Presence: active and AFK ---

test("move accrues AFK charge for the active play since the trogg's last input", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, kindlingCharge: 0, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }, { now: micros(60_000) }); // one minute later
  move(ctx, { dirX: 1, dirY: 0, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.kindlingCharge, AFK_CHARGE_ACCRUAL_RATE); // one minute of active play
});

test("move never accrues AFK charge past AFK_CHARGE_MAX", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, kindlingCharge: AFK_CHARGE_MAX, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }, { now: micros(60_000) });
  move(ctx, { dirX: 1, dirY: 0, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.equal(p.kindlingCharge, AFK_CHARGE_MAX);
});

test("onDisconnect leaves a charged trogg afk in place when it's already on lit ground", () => {
  const me = id("staying");
  const ctx = makeCtx({ sender: me });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.player.insert(playerRow(me, { x: 69, y: 96, online: true, kindlingCharge: 5, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  onDisconnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ x: p.x, y: p.y, online: p.online, kindlingCharge: p.kindlingCharge }, { x: 69, y: 96, online: false, kindlingCharge: 5 });
});

test("onDisconnect recalls a charged trogg off lit ground to the nearest hearth, keeping what it carries", () => {
  const me = id("recalled");
  const ctx = makeCtx({ sender: me });
  const hearth = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.player.insert(playerRow(me, { x: 200, y: 150, online: true, carrying: "boulder", kindlingCharge: 5, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  onDisconnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual(
    { x: p.x, y: p.y, online: p.online, carrying: p.carrying, boulderRows: ctx.db.boulder.rows().length },
    { x: hearth.x, y: hearth.y, online: false, carrying: "boulder", boulderRows: 0 },
  );
});

test("onDisconnect settles a trogg with no AFK charge left at the nearest hearth", () => {
  const me = id("dormantnow");
  const ctx = makeCtx({ sender: me });
  const hearth = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.player.insert(playerRow(me, { x: 200, y: 150, online: true, kindlingCharge: 0, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  onDisconnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ x: p.x, y: p.y, kindlingCharge: p.kindlingCharge }, { x: hearth.x, y: hearth.y, kindlingCharge: 0 });
});

test("onConnect resumes active play instantly, settling however much charge decay happened while away", () => {
  const me = id("returning");
  const ctx = makeCtx({ sender: me, now: micros(3_600_000) }); // an hour later
  ctx.db.player.insert(playerRow(me, { x: 69, y: 96, online: false, kindlingCharge: AFK_CHARGE_MAX, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  onConnect(ctx);
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ online: p.online, kindlingCharge: p.kindlingCharge }, { online: true, kindlingCharge: AFK_CHARGE_MAX - AFK_CHARGE_DECAY_RATE }); // one hour of afk decay
});

test("wanderPresence keeps a charged afk trogg confined to lit territory while it wanders", () => {
  const watcher = id("watcher");
  const afk = id("afktrogg");
  // random 0.9 clears both the idle and gather rolls; 5s at walk speed is far
  // enough that an unconfined wanderer would clear the lit radius easily.
  const ctx = makeCtx({ sender: watcher, random: 0.9, integerInRange: () => 0, now: micros(5_000) });
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 0, y: 0 }));
  const hearth = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  const p = ctx.db.player.identity.find(afk);
  assert.ok(Math.hypot(p.x - hearth.x, p.y - hearth.y) <= hearth.radius);
});

test("wanderPresence keeps a spent-charge trogg gathering at the trickle rate", () => {
  const watcher = id("watcher");
  const spent = id("driedout");
  // 0.05 lands under AFK_TRICKLE_EFFICIENCY_FRACTION, so even a drained trogg chips.
  const ctx = makeCtx({ sender: watcher, random: 0.05 });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE }); // breaks on one chip
  ctx.db.player.insert(playerRow(spent, { x: 69, y: 96, online: false, kindlingCharge: 0, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, spent);
  wanderPresence(ctx, {});
  assert.deepEqual(
    { boulders: ctx.db.boulder.rows().length, stone: ctx.db.stockpile.item.find("stone")?.qty },
    { boulders: 0, stone: 1 },
  );
});

test("wanderPresence holds a spent-charge trogg to the slower roll — a full-rate roll misses", () => {
  const watcher = id("watcher");
  const spent = id("driedout2");
  // 0.2 would chip for a charged AFK trogg (< AFK_EFFICIENCY_FRACTION) but misses the spent trickle.
  const ctx = makeCtx({ sender: watcher, random: 0.2 });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE });
  ctx.db.player.insert(playerRow(spent, { x: 69, y: 96, online: false, kindlingCharge: 0, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, spent);
  wanderPresence(ctx, {});
  assert.equal(ctx.db.boulder.rows()[0]?.health, AFK_GATHER_DAMAGE); // camped beside it, chip missed
});

test("wanderPresence gathers on instinct from an adjacent boulder and deposits into the stockpile", () => {
  const watcher = id("watcher");
  const afk = id("gathering");
  // 0.2 clears the idle roll (stands still) and the gather roll (< AFK_EFFICIENCY_FRACTION) alike.
  const ctx = makeCtx({ sender: watcher, random: 0.2 });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE }); // breaks on one chip
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  assert.deepEqual(
    { boulders: ctx.db.boulder.rows().length, stone: ctx.db.stockpile.item.find("stone")?.qty, respawnsArmed: ctx.db.nodeRespawn.rows().length },
    { boulders: 0, stone: 1, respawnsArmed: 1 },
  );
});

test("wanderPresence equips the pickaxe from the trogg's own inventory to work a boulder", () => {
  const watcher = id("watcher");
  const afk = id("toolswap");
  const ctx = makeCtx({ sender: watcher, random: 0.2, now: micros(5_000) }); // 0.2 chips (full AFK rate)
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: 100 });
  const pick = ctx.db.inventory.insert({ id: 0n, playerId: afk, item: "pickaxe", qty: 1 });
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, equippedMainHand: "axe", kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: micros(5_000) } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  const p = ctx.db.player.identity.find(afk);
  assert.deepEqual(
    { held: p.equippedMainHand, heldRow: p.equippedMainHandInventoryId, swing: p.equipmentAction, swungAt: p.equipmentActionAt.microsSinceUnixEpoch },
    { held: "pickaxe", heldRow: pick.id, swing: "pickaxe", swungAt: micros(5_000) },
  );
});

test("wanderPresence swings bare fists at a node when the trogg owns no tool", () => {
  const watcher = id("watcher");
  const afk = id("nofists");
  const ctx = makeCtx({ sender: watcher, random: 0.2, now: micros(5_000) });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.tree.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: 100 });
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: micros(5_000) } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  const p = ctx.db.player.identity.find(afk);
  assert.deepEqual({ held: p.equippedMainHand, swing: p.equipmentAction }, { held: "", swing: "fists" });
});

test("wanderPresence sheds run state and speed cheats — instinct moves at walk speed", () => {
  const watcher = id("watcher");
  const afk = id("speedster");
  const ctx = makeCtx({ sender: watcher, random: 0.9, integerInRange: () => 0 });
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 0, y: 0 }));
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "r1x1" }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 66, y: 96, health: 100 });
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, running: true, cheatSpeed: 5, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  const p = ctx.db.player.identity.find(afk);
  assert.deepEqual({ running: p.running, cheatSpeed: p.cheatSpeed, pathing: p.path !== "" }, { running: false, cheatSpeed: 1, pathing: true });
});

test("respawnNodes re-plants a broken boulder in place at full health", () => {
  const watcher = id("watcher");
  const ctx = makeCtx({ sender: watcher });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.nodeRespawn.insert({ scheduledId: 0n, scheduledAt: 0n, zoneId: ZONE, kind: "boulder", x: 70, y: 96 });
  respawnNodes(ctx, { timer: ctx.db.nodeRespawn.rows()[0] });
  const b = ctx.db.boulder.rows()[0];
  assert.deepEqual(
    { x: b?.x, y: b?.y, health: b?.health, timers: ctx.db.nodeRespawn.rows().length },
    { x: 70, y: 96, health: BOULDER_MAX_HEALTH, timers: 0 },
  );
});

test("respawnNodes re-arms instead of trapping a trogg standing on the node's tile", () => {
  const watcher = id("watcher");
  const ctx = makeCtx({ sender: watcher });
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 70, y: 96 }));
  ctx.db.nodeRespawn.insert({ scheduledId: 0n, scheduledAt: 0n, zoneId: ZONE, kind: "tree", x: 70, y: 96 });
  respawnNodes(ctx, { timer: ctx.db.nodeRespawn.rows()[0] });
  assert.deepEqual({ trees: ctx.db.tree.rows().length, timers: ctx.db.nodeRespawn.rows().length }, { trees: 0, timers: 1 });
});

test("wanderPresence routes an afk trogg toward the nearest node instead of drifting", () => {
  const watcher = id("watcher");
  const afk = id("seeker");
  // 0.9 misses the gather roll; no adjacent node anyway, so the trogg must route.
  const ctx = makeCtx({ sender: watcher, random: 0.9, integerInRange: () => 0 });
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 0, y: 0 }));
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "r1x1" })); // the region holding (69, 96)
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 66, y: 96, health: 100 }); // three tiles of open floor west
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  const p = ctx.db.player.identity.find(afk);
  assert.deepEqual({ pathing: p.path !== "", dirX: p.dirX }, { pathing: true, dirX: -1 }); // en route west, toward the boulder
});

test("wanderPresence camps an afk trogg beside its node between chips", () => {
  const watcher = id("watcher");
  const afk = id("camper");
  const ctx = makeCtx({ sender: watcher, random: 0.9 }); // misses the gather roll
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 0, y: 0 }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: 100 });
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  const p = ctx.db.player.identity.find(afk);
  assert.deepEqual(
    { x: p.x, y: p.y, dirX: p.dirX, dirY: p.dirY, path: p.path, health: ctx.db.boulder.rows()[0].health },
    { x: 69, y: 96, dirX: 0, dirY: 0, path: "", health: 100 }, // stays put, node intact until a chip lands
  );
});

test("wanderPresence re-arms only while a player is online", () => {
  const afk = id("alone");
  const ctx = makeCtx({ sender: afk });
  ctx.db.player.insert(playerRow(afk, { online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);
  wanderPresence(ctx, {});
  assert.equal(ctx.db.afkWanderTimer.rows().length, 0); // nobody's watching, so no further work
});

// --- Dark creatures ---

test("onConnect seeds the world zone's dark creature population, idempotently", () => {
  const me = id("newguest2");
  const ctx = makeCtx({ sender: me });
  ctx.db.revealedRegion.clear(); // a fresh world, before the hearth bootstrap
  onConnect(ctx);
  const count = ctx.db.darkCreature.rows().filter((c: any) => c.zoneId === ZONE).length;
  assert.ok(count > 0);

  (ctx as any).sender = id("anotherguest2");
  onConnect(ctx);
  assert.equal(ctx.db.darkCreature.rows().filter((c: any) => c.zoneId === ZONE).length, count);
});

test("wanderPresence keeps an unaggroed dark creature off lit ground while it wanders", () => {
  const watcher = id("watcher");
  const ctx = makeCtx({ sender: watcher, random: 0.9, integerInRange: () => 0, now: micros(5_000) });
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 0, y: 0 }));
  const hearth = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 80, y: 96 })); // outside the lit radius
  wanderPresence(ctx, {});
  const after = ctx.db.darkCreature.id.find(c.id);
  assert.ok(Math.hypot(after.x - hearth.x, after.y - hearth.y) > hearth.radius);
});

test("wanderPresence aggroes onto a active trogg within DARK_CREATURE_AGGRO_RANGE", () => {
  const me = id("prey");
  const ctx = makeCtx({ sender: me, random: 0.9 });
  ctx.db.player.insert(playerRow(me, { online: true, x: 69, y: 96 }));
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 70, y: 96 })); // 1 tile away, well within range
  wanderPresence(ctx, {});
  assert.equal(ctx.db.darkCreature.id.find(c.id)?.aggroTargetId, me.toHexString());
  assert.ok(DARK_CREATURE_AGGRO_RANGE >= 1);
});

test("wanderPresence drops aggro once its target is no longer online", () => {
  const watcher = id("watcher");
  const target = id("wasHere");
  const ctx = makeCtx({ sender: watcher, random: 0.9, integerInRange: () => 0 });
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 0, y: 0 }));
  ctx.db.player.insert(playerRow(target, { online: false, x: 70, y: 96 }));
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 69, y: 96, aggroTargetId: target.toHexString() }));
  wanderPresence(ctx, {});
  assert.equal(ctx.db.darkCreature.id.find(c.id)?.aggroTargetId, ""); // no active trogg nearby to re-aggro onto
});

test("wanderPresence turns an aggroed dark creature toward a target out of melee range", () => {
  const target = id("faraway");
  const ctx = makeCtx({ sender: target });
  ctx.db.player.insert(playerRow(target, { online: true, x: 72, y: 96, health: PLAYER_MAX_HEALTH })); // 3 tiles east, out of reach
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 69, y: 96, aggroTargetId: target.toHexString() }));
  wanderPresence(ctx, {});
  const after = ctx.db.darkCreature.id.find(c.id);
  assert.deepEqual({ headingEast: after.dirX > 0, dirY: after.dirY }, { headingEast: true, dirY: 0 });
  assert.equal(ctx.db.player.identity.find(target).health, PLAYER_MAX_HEALTH); // too far to land a hit yet
});

test("wanderPresence attacks an aggroed target in melee range and stops advancing", () => {
  const target = id("closeby");
  const ctx = makeCtx({ sender: target });
  ctx.db.player.insert(playerRow(target, { online: true, x: 70, y: 96, health: PLAYER_MAX_HEALTH }));
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 69, y: 96, aggroTargetId: target.toHexString() }));
  wanderPresence(ctx, {});
  const after = ctx.db.darkCreature.id.find(c.id);
  const def = DARK_CREATURES.grask!;
  assert.deepEqual(
    { dirX: after.dirX, dirY: after.dirY, health: ctx.db.player.identity.find(target).health },
    { dirX: 0, dirY: 0, health: PLAYER_MAX_HEALTH - def.damage[0] }, // the mock RNG rolls the floor
  );
});

test("useEquipped damages a faced dark creature with a sword", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 70, y: 96, health: 40 }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.darkCreature.id.find(c.id)?.health, 40 - WEAPON_DAMAGE.sword![0]);
});

test("a swing hits a dark creature over an equally distant trogg", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const bystander = id("bystander");
  ctx.db.player.insert(playerRow(bystander, { x: 70, y: 96, health: PLAYER_MAX_HEALTH }));
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 70, y: 96, health: 40 }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.deepEqual(
    { creatureHealth: ctx.db.darkCreature.id.find(c.id)?.health, troggHealth: ctx.db.player.identity.find(bystander).health },
    { creatureHealth: 40 - WEAPON_DAMAGE.sword![0], troggHealth: PLAYER_MAX_HEALTH },
  );
});

test("the killing blow settles a dark creature as a corpse and drops its loot", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 70, y: 96, health: WEAPON_DAMAGE.sword![0], aggroTargetId: me.toHexString() }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const corpse = ctx.db.darkCreature.id.find(c.id);
  assert.deepEqual(
    { health: corpse.health, dirX: corpse.dirX, dirY: corpse.dirY, aggroTargetId: corpse.aggroTargetId, dropped: ctx.db.groundItem.rows().length },
    { health: 0, dirX: 0, dirY: 0, aggroTargetId: "", dropped: 1 },
  );
  assert.equal(ctx.db.groundItem.rows()[0]!.item, DARK_CREATURES.grask!.loot.item);
});

test("regenCreatures leaves a fresh corpse in place before NPC_CORPSE_MS elapses", () => {
  const me = id("watcher5");
  const ctx = makeCtx({ sender: me, now: micros(1000) });
  ctx.db.player.insert(playerRow(me, { online: true }));
  ctx.db.darkCreature.insert(darkCreatureRow({ x: 200, y: 150, health: 0, lastDamagedAt: { microsSinceUnixEpoch: 0n } }));
  regenCreatures(ctx, {});
  assert.equal(ctx.db.darkCreature.rows().length, 1);
});

test("regenCreatures reaps a corpse on unlit ground and respawns a fresh creature there", () => {
  const me = id("watcher3");
  const ctx = makeCtx({ sender: me, now: micros(NPC_CORPSE_MS + 1000) });
  ctx.db.player.insert(playerRow(me, { online: true }));
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 200, y: 150, health: 0, lastDamagedAt: { microsSinceUnixEpoch: 0n } }));

  regenCreatures(ctx, {});

  const rows = ctx.db.darkCreature.rows().filter((r: any) => r.x === 200 && r.y === 150);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].health, DARK_CREATURES.grask!.maxHealth);
  assert.notEqual(rows[0].id, c.id); // a fresh row, not the reaped corpse
});

test("regenCreatures reaps a corpse on lit ground without respawning", () => {
  const me = id("watcher4");
  const ctx = makeCtx({ sender: me, now: micros(NPC_CORPSE_MS + 1000) });
  ctx.db.player.insert(playerRow(me, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.darkCreature.insert(darkCreatureRow({ x: 69, y: 96, health: 0, lastDamagedAt: { microsSinceUnixEpoch: 0n } }));

  regenCreatures(ctx, {});

  assert.equal(ctx.db.darkCreature.rows().length, 0);
});

test("regenCreatures heals a living dark creature untouched past HEALTH_REGEN_DELAY_MS", () => {
  const me = id("watcher6");
  const ctx = makeCtx({ sender: me, now: micros(HEALTH_REGEN_DELAY_MS + 1000) });
  ctx.db.player.insert(playerRow(me, { online: true }));
  const def = DARK_CREATURES.grask!;
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 200, y: 150, health: def.maxHealth - 20, lastDamagedAt: { microsSinceUnixEpoch: 0n } }));

  regenCreatures(ctx, {});

  const heal = Math.ceil(def.maxHealth * HEALTH_REGEN_FRACTION);
  assert.equal(ctx.db.darkCreature.id.find(c.id)?.health, Math.min(def.maxHealth, def.maxHealth - 20 + heal));
});

test("spawn places a dark creature of the requested species", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "dark_creature", item: "grask" });
  assert.equal(ctx.db.darkCreature.rows().length, 1);
  assert.equal(ctx.db.darkCreature.rows()[0]!.species, "grask");
});

test("spawn refuses an unrecognised dark-creature species", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  spawn(ctx, { kind: "dark_creature", item: "not-a-species" });
  assert.equal(ctx.db.darkCreature.rows().length, 0);
});

test("spawn refuses a dark creature once the zone is at its cap", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  for (let i = 0; i < MAX_DARK_CREATURES_PER_ZONE; i++) ctx.db.darkCreature.insert(darkCreatureRow({ x: 65, y: 89 }));
  spawn(ctx, { kind: "dark_creature", item: "grask" });
  assert.equal(ctx.db.darkCreature.rows().length, MAX_DARK_CREATURES_PER_ZONE);
});

test("resetDarkCreatures clears the zone (corpses included) and reseeds from the registry", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  ctx.db.darkCreature.insert(darkCreatureRow({ x: 65, y: 89, health: 0 })); // a stray corpse
  resetDarkCreatures(ctx, {});
  const zone = getZone(ZONE)!;
  assert.equal(ctx.db.darkCreature.rows().length, zone.darkCreatures.length);
});

// --- Territory claiming: clear the zone, then set a free brazier down ---

// A penumbra region one lattice hop east of the Hearth, and one two hops out —
// capitals are open plazas by construction, so tests stand troggs there.
const NEIGHBOR = capitalOf(1, 0);
const FAR = capitalOf(2, 0);

test("interact refuses to claim a penumbra region while a dark creature is still alive in it", () => {
  const { ctx, me } = withPlayer({ x: NEIGHBOR.x, y: NEIGHBOR.y });
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  ctx.db.darkCreature.insert(darkCreatureRow({ x: NEIGHBOR.x + 1, y: NEIGHBOR.y, health: 40 }));
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.deepEqual(
    { carrying: ctx.db.player.identity.find(me).carrying, braziers: ctx.db.brazier.rows().length, revealed: ctx.db.revealedRegion.rows().length },
    { carrying: "", braziers: 0, revealed: 1 },
  );
});

test("interact claims a cleared penumbra region, paying the brazier's stone cost from the stockpile", () => {
  const { ctx, me } = withPlayer({ x: NEIGHBOR.x, y: NEIGHBOR.y });
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  ctx.db.stockpile.insert({ item: "stone", qty: BRAZIER_CLAIM_STONE_COST + 5 });
  ctx.db.darkCreature.insert(darkCreatureRow({ x: NEIGHBOR.x + 1, y: NEIGHBOR.y, health: 0 })); // a corpse doesn't block the claim
  interact(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, 5); // the stone builds the fire
  const brazier = ctx.db.brazier.rows()[0];
  assert.deepEqual(
    { carrying: ctx.db.player.identity.find(me).carrying, count: ctx.db.brazier.rows().length, lit: brazier?.lit, isEternal: brazier?.isEternal },
    { carrying: "", count: 1, lit: true, isEternal: false },
  );
  const rows = ctx.db.revealedRegion.rows();
  assert.ok(rows.find((r: any) => r.slug === NEIGHBOR.slug)?.interior, "the claimed region flips interior");
  // the claim exposes the claimed region's own still-unclaimed neighbours as
  // penumbra rows — locked names, populations seeded — so the next scout
  // already has somewhere fresh to find
  const exposed = rows.filter((r: any) => !r.interior).map((r: any) => r.slug);
  assert.ok(exposed.includes(FAR.slug), `expected ${FAR.slug} among the new penumbra: ${exposed.join(", ")}`);
  assert.ok(regionSeeds(FAR.slug).darkCreatures.length > 0, "precondition: the exposed region has creature seeds");
  const inFar = (t: { x: number; y: number }) => regionAt(t.x, t.y).slug === FAR.slug;
  assert.ok(ctx.db.darkCreature.rows().some((c: any) => inFar(c)), `${FAR.slug} missing seeded dark creatures`);
  // every penumbra row locked a unique display name the moment it was exposed
  const names = rows.map((r: any) => r.name);
  assert.equal(new Set(names).size, names.length, `region names collide: ${names.join(", ")}`);
});

test("interact refuses a second claim in a region that already has a brazier", () => {
  const { ctx, me } = withPlayer({ x: NEIGHBOR.x, y: NEIGHBOR.y });
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  ctx.db.stockpile.insert({ item: "stone", qty: BRAZIER_CLAIM_STONE_COST * 2 });
  interact(ctx, { dirX: 1, dirY: 0 }); // clears (no creatures) and claims

  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), x: NEIGHBOR.x, y: NEIGHBOR.y + 1, dirX: 0, dirY: 0 });
  interact(ctx, { dirX: 1, dirY: 0 }); // already interior — no second claim, falls through to pickup

  assert.equal(ctx.db.brazier.rows().length, 1);
});

test("interact relights a guttered brazier in an interior region for free, even with living dark creatures nearby", () => {
  const { ctx, me } = withPlayer({ x: NEIGHBOR.x, y: NEIGHBOR.y });
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: NEIGHBOR.slug, name: "Neighbourfen" })); // already claimed — interior
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: NEIGHBOR.x + 1, y: NEIGHBOR.y, radius: BRAZIER_LIT_RADIUS, lit: false, isEternal: false }); // guttered
  ctx.db.darkCreature.insert(darkCreatureRow({ x: NEIGHBOR.x + 1, y: NEIGHBOR.y, health: 40 })); // wouldn't matter even if alive
  interact(ctx, { dirX: 1, dirY: 0 }); // faces the guttered brazier's site
  assert.deepEqual(
    { carrying: ctx.db.player.identity.find(me).carrying, lit: ctx.db.brazier.rows()[0]?.lit },
    { carrying: "", lit: true },
  );
});

// --- Lazy worldgen (region reveal) ---
// The fake ctx pre-seeds a block of regions around the origin as claimed (see
// spacetime.ts) so the rest of the suite sees the ground it uses as walkable;
// these tests explicitly narrow the revealed set to exercise the frontier itself.

test("onConnect claims the Hearth and exposes its lattice neighbours as the initial penumbra", () => {
  const me = id("newguest-frontier");
  const ctx = makeCtx({ sender: me });
  ctx.db.revealedRegion.clear(); // start from an unclaimed frontier, like a fresh world
  onConnect(ctx);
  const rows = ctx.db.revealedRegion.rows();
  assert.deepEqual(rows.filter((r: any) => r.interior).map((r: any) => r.slug), ["hearth"]);
  assert.deepEqual(
    rows.filter((r: any) => !r.interior).map((r: any) => r.slug).sort(),
    [...neighborsOf("hearth")].sort(),
  );
  assert.ok(ctx.db.darkCreature.rows().length > 0);
});

test("onConnect is idempotent about claiming the Hearth and its penumbra", () => {
  const me = id("newguest-frontier2");
  const ctx = makeCtx({ sender: me });
  ctx.db.revealedRegion.clear();
  onConnect(ctx);
  const rowCount = ctx.db.revealedRegion.rows().length;
  const darkCount = ctx.db.darkCreature.rows().length;
  (ctx as any).sender = id("anotherguest-frontier2");
  onConnect(ctx);
  assert.equal(ctx.db.revealedRegion.rows().length, rowCount);
  assert.equal(ctx.db.darkCreature.rows().length, darkCount);
});

test("moveTo's pathfinding never routes through an unreached region", () => {
  const { ctx, me } = withPlayer({ x: NEIGHBOR.x, y: NEIGHBOR.y }); // penumbra of the Hearth
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  // the first tile of the two-hops-out region along the line toward its capital
  let target: { x: number; y: number } | undefined;
  for (let step = 0; step < 200 && !target; step++) {
    const x = Math.round(NEIGHBOR.x + (FAR.x - NEIGHBOR.x) * (step / 200));
    const y = Math.round(NEIGHBOR.y + (FAR.y - NEIGHBOR.y) * (step / 200));
    if (regionAt(x, y).slug === FAR.slug) target = { x, y };
  }
  assert.ok(target, "no border tile found");
  moveTo(ctx, { x: target!.x, y: target!.y, running: false });
  const p = ctx.db.player.identity.find(me);
  const waypoints = [{ x: p.x, y: p.y }, ...parsePath(p.path)];
  for (const step of waypoints) assert.notEqual(regionAt(step.x, step.y).slug, FAR.slug);
});

test("move keeps working freely inside an already-revealed penumbra region", () => {
  const { ctx, me } = withPlayer({ x: NEIGHBOR.x, y: NEIGHBOR.y }); // penumbra of the Hearth
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  move(ctx, { dirX: 1, dirY: 0, running: false });
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY }, { dirX: 1, dirY: 0 });
});

test("interact refuses to claim from an unreached region, even with nothing alive there", () => {
  const { ctx, me } = withPlayer({ x: FAR.x, y: FAR.y }); // two hops out — not even penumbra
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.deepEqual(
    { carrying: ctx.db.player.identity.find(me).carrying, braziers: ctx.db.brazier.rows().length, revealed: ctx.db.revealedRegion.rows().length },
    { carrying: "", braziers: 0, revealed: 1 },
  );
});

test("revealNextRegion claims one penumbra region directly, skipping the clear-the-zone requirement", () => {
  const ctx = makeCtx({ sender: id("admin1") });
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  revealNextRegion(ctx);
  const interior = ctx.db.revealedRegion.rows().filter((r: any) => r.interior).map((r: any) => r.slug);
  assert.equal(interior.length, 2);
  const claimed = interior.find((slug: string) => slug !== "hearth")!;
  assert.ok(neighborsOf("hearth").includes(claimed));
  assert.equal(ctx.db.brazier.rows().length, 1); // the shortcut leaves a lit brazier, like a real claim
});

test("jumpRegions claims a chain of regions marching outward from the frontier", () => {
  const ctx = makeCtx({ sender: id("admin-jump") });
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  jumpRegions(ctx, { count: 5 });
  const interior = ctx.db.revealedRegion.rows().filter((r: any) => r.interior);
  assert.equal(interior.length, 6); // the hearth plus five claims
  assert.equal(ctx.db.brazier.rows().length, 5);
});

test("resetFrontier clears every claimed region back to just the Hearth", () => {
  const ctx = makeCtx({ sender: id("admin3") }); // the default ctx starts with a claimed block
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: capitalOf(1, 0).x, y: capitalOf(1, 0).y, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  resetFrontier(ctx);
  const rows = ctx.db.revealedRegion.rows();
  assert.deepEqual(rows.filter((r: any) => r.interior).map((r: any) => r.slug), ["hearth"]);
  // the Hearth's own penumbra is re-exposed immediately, so the frontier still has names
  assert.deepEqual(
    rows.filter((r: any) => !r.interior).map((r: any) => r.slug).sort(),
    [...neighborsOf("hearth")].sort(),
  );
  assert.equal(ctx.db.brazier.rows().length, 0); // claim braziers go with the claims
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
  onConnect(ctx);
  const zone = getZone(ZONE)!;
  for (const b of ctx.db.boulder.zoneId.filter(ZONE)) {
    assert.ok(isWalkable(zone, b.x, b.y), `reseeded boulder at ${b.x},${b.y} is in rock`);
  }
  assert.ok(ctx.db.boulder.zoneId.filter(ZONE).length > 0);
});

test("onConnect leaves healthy world rows alone", () => {
  const me = id("keeper");
  const ctx = makeCtx({ sender: me });
  const seed = regionSeeds("hearth").boulders[0]!;
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
  // the alcove ring is guaranteed rock, with the pocket floor right beside it
  const wall = { x: 33, y: 55 };
  assert.ok(!isWalkable(zone, wall.x, wall.y) && isWalkable(zone, wall.x + 1, wall.y));
  const { ctx, me } = withPlayer({ x: wall.x, y: wall.y, cheatNoclip: true });
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
  const occupied = zoneBounds(zone, (x, y) => x === 35 && y === 35);
  const low = projectMotion({ x: 33, y: 35, dirX: 1000, dirY: 0, cheatFly: true, z: 1, dirZ: 0 }, 1_000, occupied);
  assert.ok(low.x < 35, `low flyer clamped at ${low.x}`);
  const high = projectMotion({ x: 33, y: 35, dirX: 1000, dirY: 0, cheatFly: true, z: FLY_CLEAR_OBSTACLE + 1, dirZ: 0 }, 1_000, occupied);
  assert.ok(high.x > 35, `high flyer passed to ${high.x}`);
  // rock clears at its rendered per-tile height — just below bumps, just above
  // passes. The alcove ring is guaranteed rock, approached over the bypass street.
  const wall = { x: 33, y: 55 };
  assert.ok(!isWalkable(zone, wall.x, wall.y) && isWalkable(zone, wall.x - 1, wall.y));
  const bounds = zoneBounds(zone);
  const summit = rockHeightAt(zone, wall.x, wall.y);
  const below = projectMotion({ x: wall.x - 1, y: wall.y, dirX: 1000, dirY: 0, cheatFly: true, z: summit - 0.05, dirZ: 0 }, 1_000, bounds);
  assert.ok(below.x < wall.x, `flyer under the rock top clamped at ${below.x} before wall ${wall.x}`);
  const above = projectMotion({ x: wall.x - 1, y: wall.y, dirX: 1000, dirY: 0, cheatFly: true, z: summit + 0.05, dirZ: 0 }, 1_000, bounds);
  assert.ok(above.x >= wall.x, `flyer over the rock top passed to ${above.x}`);
});

test("healSelf restores a living trogg to full health", () => {
  const { ctx, me } = withPlayer({ x: 108, y: 105, health: 7 });
  healSelf(ctx);
  assert.equal(ctx.db.player.identity.find(me).health, PLAYER_MAX_HEALTH);
});

test("rescue lands a stuck trogg on standable ground", () => {
  const zone = getZone(ZONE)!;
  const wall = { x: 33, y: 55 }; // the alcove ring — guaranteed rock beside floor
  const { ctx, me } = withPlayer({ x: wall.x, y: wall.y, cheatNoclip: true, z: 6, cheatFly: true });
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


// --- Skills and XP ---

const skillXp = (ctx: any, playerId: any, skill: string) => ctx.db.skills.rows().find((r: any) => r.playerId === playerId && r.skill === skill)?.xp;

test("the breaking hit grants mining XP; a mid-swing chip grants none", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "pickaxe" });
  const pickaxe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "pickaxe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: pickaxe.id });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: BOULDER_MAX_HEALTH });

  useEquipped(ctx, { dirX: 1, dirY: 0 }); // chips, doesn't break
  assert.equal(skillXp(ctx, me, "mining"), undefined);

  ctx.db.boulder.rows().forEach((b: any) => ctx.db.boulder.id.update({ ...b, health: 1 })); // worn to the last blow
  ctx.timestamp = { microsSinceUnixEpoch: micros(1000) };
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(skillXp(ctx, me, "mining"), GATHER_XP); // the completed gather grants, once
});

test("felling a tree grants woodcutting XP", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "axe" });
  const axe = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "axe", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: axe.id });
  ctx.db.tree.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: WEAPON_DAMAGE.axe![0] }); // breaks on one blow

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.equal(skillXp(ctx, me, "woodcutting"), GATHER_XP);
  assert.equal(skillXp(ctx, me, "mining"), undefined); // each gather trains its own track
});

test("damaging a dark creature grants combat XP per point dealt, clamped to its remaining health", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const perHit = WEAPON_DAMAGE.sword![0];
  ctx.db.darkCreature.insert(darkCreatureRow({ x: 70, y: 96, health: perHit + 100 }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(skillXp(ctx, me, "combat"), perHit * COMBAT_XP_PER_DAMAGE); // a clean hit pays its damage

  // a killing blow on a nearly-dead creature pays only the health it took, not the overkill
  ctx.db.darkCreature.rows().forEach((c: any) => ctx.db.darkCreature.id.delete(c.id));
  ctx.db.darkCreature.insert(darkCreatureRow({ x: 70, y: 96, health: 3 }));
  ctx.timestamp = { microsSinceUnixEpoch: micros(1000) };
  useEquipped(ctx, { dirX: 1, dirY: 0 });
  assert.equal(skillXp(ctx, me, "combat"), (perHit + 3) * COMBAT_XP_PER_DAMAGE);
});

test("damaging a trogg grants no combat XP — no progression incentive to hit the tribe", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  ctx.db.player.insert(playerRow(id("victim"), { x: 70, y: 96, health: PLAYER_MAX_HEALTH }));

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  assert.notEqual(ctx.db.player.identity.find(id("victim")).health, PLAYER_MAX_HEALTH); // the hit landed
  assert.equal(ctx.db.skills.rows().length, 0); // and paid nothing
});

test("AFK instinct gathering deposits but never grants XP", () => {
  const watcher = id("watcher");
  const afk = id("instinct");
  const ctx = makeCtx({ sender: watcher, random: 0.05 }); // 0.05 chips even at the trickle rate
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE }); // breaks on one chip
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);

  wanderPresence(ctx, {});

  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, 1); // instinct works...
  assert.deepEqual(ctx.db.skills.rows().map((r: any) => r.xp), [AFK_UNLOCK_XP]); // ...but never grows (pillar 7)
});


// --- The AFK eligibility gate ---

test("wanderPresence skips an offline trogg below the AFK eligibility gate", () => {
  const watcher = id("watcher");
  const fresh = id("freshguest");
  const ctx = makeCtx({ sender: watcher, random: 0.05 }); // a roll that would chip for any eligible trogg
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE });
  ctx.db.player.insert(playerRow(fresh, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));

  wanderPresence(ctx, {});

  // below the gate a disconnect is a plain offline: no instinct, no deposit
  assert.equal(ctx.db.boulder.rows().length, 1);
  assert.equal(ctx.db.stockpile.item.find("stone"), undefined);
});

test("the gate reads total XP across skills, not any single track", () => {
  const watcher = id("watcher");
  const mixed = id("mixedbag");
  const ctx = makeCtx({ sender: watcher, random: 0.05 });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE });
  ctx.db.player.insert(playerRow(mixed, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  ctx.db.skills.insert({ id: 0n, playerId: mixed, skill: "combat", xp: AFK_UNLOCK_XP - 300 });
  ctx.db.skills.insert({ id: 0n, playerId: mixed, skill: "woodcutting", xp: 300 });

  wanderPresence(ctx, {});

  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, 1); // 500 + 300 = the 800 gate, mixed tracks count
});


// --- The trickle wind-down and week-offline hiding ---

test("the spent trickle winds down with absence — a roll that chips early misses at half a week", () => {
  const watcher = id("watcher");
  const fading = id("fading");
  const halfWeek = 3.5 * 24 * 60 * 60 * 1000;
  // 0.07 chips against the flat trickle (0.1) but misses the half-week rate (0.05)
  const ctx = makeCtx({ sender: watcher, random: 0.07, now: micros(halfWeek) });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE });
  ctx.db.player.insert(playerRow(fading, { x: 69, y: 96, online: false, kindlingCharge: 0, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, fading);

  wanderPresence(ctx, {});
  assert.equal(ctx.db.stockpile.item.find("stone"), undefined); // wound down past this roll

  ctx.random = () => 0.04; // still under the half-week rate — the trickle lives
  wanderPresence(ctx, {});
  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, 1);
});

test("a week away hides the trogg: the sweep leaves it be entirely", () => {
  const watcher = id("watcher");
  const gone = id("longgone");
  const ctx = makeCtx({ sender: watcher, random: 0.01, now: micros(AFK_HIDE_AFTER_MS + 60_000) });
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE });
  ctx.db.player.insert(playerRow(gone, { x: 69, y: 96, online: false, kindlingCharge: 0, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, gone);
  const before = ctx.db.player.identity.find(gone);

  wanderPresence(ctx, {});

  assert.equal(ctx.db.stockpile.item.find("stone"), undefined); // no work
  assert.deepEqual(ctx.db.player.identity.find(gone), before); // row untouched — hidden, not deleted
});


test("a world death respawns at the lit brazier nearest the death tile, not the cave alcove", () => {
  const { ctx, me } = withPlayer({ x: 200, y: 150, dead: true, health: 0, respawnAt: { microsSinceUnixEpoch: 0n } });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 0, y: 0, radius: FIRST_FIRE_LIT_RADIUS, lit: true, isEternal: true }); // the First Fire, far away
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 198, y: 150, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false }); // the fire fought beside
  const timer = ctx.db.playerRespawn.insert({ scheduledId: 0n, playerId: me, scheduledAt: 0n });
  ctx.timestamp = { microsSinceUnixEpoch: micros(PLAYER_RESPAWN_MS + 1000) };

  respawnPlayers(ctx, { timer });

  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ x: p.x, y: p.y, dead: p.dead, health: p.health }, { x: 198, y: 150, dead: false, health: PLAYER_MAX_HEALTH });
});


test("interact refuses to claim a cleared region the stockpile can't afford", () => {
  const { ctx } = withPlayer({ x: NEIGHBOR.x, y: NEIGHBOR.y });
  ctx.db.revealedRegion.clear();
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: "hearth" }));
  ctx.db.stockpile.insert({ item: "stone", qty: BRAZIER_CLAIM_STONE_COST - 1 });

  interact(ctx, { dirX: 1, dirY: 0 });

  assert.equal(ctx.db.brazier.rows().length, 0); // cleared, but the tribe can't pay for the fire yet
  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, BRAZIER_CLAIM_STONE_COST - 1); // nothing drawn
  assert.equal(ctx.db.revealedRegion.rows().find((r: any) => r.slug === NEIGHBOR.slug)?.interior ?? false, false);
});


// --- Night incursions ---

const lockNight = (ctx: any) => ctx.db.worldState.insert({ id: 0, skyLocked: true, skyPhase: 0.75 });

test("dusk seeds a night cohort into a lit region, on the rim, never near an active trogg", () => {
  const far = capitalOf(2, 0);
  const { ctx, me } = withPlayer({ x: 69, y: 96 }); // an active trogg at the Hearth
  lockNight(ctx);
  assert.ok(regionSeeds(far.slug).darkCreatures.length > 0, "precondition: the region has creature seeds");
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: far.x, y: far.y, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });

  wanderPresence(ctx, {});

  const tide = ctx.db.darkCreature.rows().filter((c: any) => c.nightborn);
  assert.ok(tide.length > 0, "the tide came in");
  const meAt = ctx.db.player.identity.find(me);
  for (const c of tide) {
    assert.ok(Math.hypot(c.x - far.x, c.y - far.y) > BRAZIER_LIT_RADIUS, "never inside the sanctuary ring");
    assert.ok(Math.hypot(c.x - meAt.x, c.y - meAt.y) >= NIGHT_SPAWN_MIN_PLAYER_DIST, "never near an active trogg");
  }

  // one tide per cycle, not a per-tick spawner
  wanderPresence(ctx, {});
  assert.equal(ctx.db.darkCreature.rows().filter((c: any) => c.nightborn).length, tide.length);
});

test("dawn despawns the night cohort and leaves the dark's residents alone", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  ctx.db.worldState.insert({ id: 0, skyLocked: true, skyPhase: 0.25 }); // noon
  ctx.db.darkCreature.insert(darkCreatureRow({ x: 200, y: 150, nightborn: true }));
  const resident = ctx.db.darkCreature.insert(darkCreatureRow({ x: 210, y: 150 }));

  wanderPresence(ctx, {});

  const left = ctx.db.darkCreature.rows();
  assert.equal(left.filter((c: any) => c.nightborn).length, 0); // the tide went out — no corpse, no loot
  assert.ok(left.some((c: any) => c.id === resident.id)); // residents are territory-linked, not tidal
});

test("at night an AFK trogg pauses gathering and idles by the fire", () => {
  const watcher = id("watcher");
  const afk = id("nightowl");
  const ctx = makeCtx({ sender: watcher, random: 0.05 }); // would chip by day
  lockNight(ctx);
  ctx.db.player.insert(playerRow(watcher, { online: true }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  ctx.db.boulder.insert({ id: 0n, zoneId: ZONE, x: 70, y: 96, health: AFK_GATHER_DAMAGE });
  ctx.db.player.insert(playerRow(afk, { x: 69, y: 96, online: false, kindlingCharge: 10, kindlingChargeAt: { microsSinceUnixEpoch: 0n } }));
  afkEligible(ctx, afk);

  wanderPresence(ctx, {});

  assert.equal(ctx.db.boulder.rows().length, 1); // untouched — instinct rests at night
  assert.equal(ctx.db.stockpile.item.find("stone"), undefined);
  const p = ctx.db.player.identity.find(afk);
  assert.deepEqual({ dirX: p.dirX, dirY: p.dirY }, { dirX: 0, dirY: 0 }); // inside the ring: huddled, idle
});


// --- Crafting ---

const atFirstFire = (ctx: any) => ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: FIRST_FIRE_LIT_RADIUS, lit: true, isEternal: true });

test("crafting draws the recipe's inputs from the stockpile and yields the item, beside the First Fire", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  atFirstFire(ctx);
  ctx.db.stockpile.insert({ item: "stone", qty: 50 });
  ctx.db.stockpile.insert({ item: "wood", qty: 50 });

  craftItem(ctx, { item: "axe" });

  assert.equal(ctx.db.inventory.rows().filter((r: any) => r.item === "axe").length, 1);
  assert.deepEqual(
    { stone: ctx.db.stockpile.item.find("stone")?.qty, wood: ctx.db.stockpile.item.find("wood")?.qty },
    { stone: 48, wood: 48 }, // 2 stone · 2 wood — the tribe's pool, not a personal stack
  );
});

test("crafting away from the First Fire is refused — the station is the Hearth's fire", () => {
  const { ctx } = withPlayer({ x: 200, y: 150 });
  atFirstFire(ctx); // at 69,96 — far away
  ctx.db.stockpile.insert({ item: "stone", qty: 50 });
  ctx.db.stockpile.insert({ item: "wood", qty: 50 });

  craftItem(ctx, { item: "axe" });

  assert.equal(ctx.db.inventory.rows().length, 0);
  assert.equal(ctx.db.stockpile.item.find("stone")?.qty, 50);
});

test("a tier recipe gates on the skill that serves it — craft = wield", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  atFirstFire(ctx);
  ctx.db.stockpile.insert({ item: "stone", qty: 50 });
  ctx.db.stockpile.insert({ item: "wood", qty: 50 });

  craftItem(ctx, { item: "fine_pickaxe" }); // mining 1 — too green
  assert.equal(ctx.db.inventory.rows().length, 0);

  ctx.db.skills.insert({ id: 0n, playerId: me, skill: "mining", xp: 800 }); // mining 5
  craftItem(ctx, { item: "fine_pickaxe" });
  assert.equal(ctx.db.inventory.rows().filter((r: any) => r.item === "fine_pickaxe").length, 1);
});

test("crafting never draws wood below the upkeep reserve — the fire eats first", () => {
  const { ctx } = withPlayer({ x: 69, y: 96 });
  atFirstFire(ctx);
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 200, y: 150, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false }); // one billed brazier
  const reserve = upkeepReserve(1);
  ctx.db.stockpile.insert({ item: "wood", qty: reserve + 1 }); // torch costs 2 — would dip below

  craftItem(ctx, { item: "torch" });
  assert.equal(ctx.db.inventory.rows().length, 0);
  assert.equal(ctx.db.stockpile.item.find("wood")?.qty, reserve + 1); // nothing drawn

  ctx.db.stockpile.item.update({ item: "wood", qty: reserve + 2 }); // exactly affordable
  craftItem(ctx, { item: "torch" });
  assert.equal(ctx.db.inventory.rows().filter((r: any) => r.item === "torch").length, 1);
  assert.equal(ctx.db.stockpile.item.find("wood")?.qty, reserve); // spent to the line, never past it
});

test("equipping tier gear demands the level that crafted it, whoever's pack it's in", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const fine = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "fine_axe", qty: 1, wear: 0 });

  equipItem(ctx, { inventoryId: fine.id });
  assert.equal(ctx.db.player.identity.find(me).equippedMainHand, ""); // woodcutting 1 can't wield it

  ctx.db.skills.insert({ id: 0n, playerId: me, skill: "woodcutting", xp: 800 }); // woodcutting 5
  equipItem(ctx, { inventoryId: fine.id });
  assert.equal(ctx.db.player.identity.find(me).equippedMainHand, "fine_axe");
});

test("an equipped torch burns down across the wander sweep and is consumed spent", () => {
  const { ctx, me } = withPlayer({ x: 69, y: 96 });
  const torch = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "torch", qty: 1, wear: TORCH_BURN_MS - AFK_WANDER_TICK_MS });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedOffHand: "torch", equippedOffHandInventoryId: torch.id });

  wanderPresence(ctx, {}); // the last tick of burn

  assert.equal(ctx.db.inventory.rows().length, 0); // spent — consumed, not durable
  const p = ctx.db.player.identity.find(me);
  assert.deepEqual({ off: p.equippedOffHand, offId: p.equippedOffHandInventoryId }, { off: "", offId: 0n });
});


test("onConnect heals a stripped world: nodes everywhere revealed, creatures only in penumbra", () => {
  const me = id("healer");
  const ctx = makeCtx({ sender: me });
  const pen = capitalOf(3, 0);
  assert.ok(regionSeeds(pen.slug).darkCreatures.length > 0, "precondition: the penumbra region has creature seeds");
  ctx.db.revealedRegion.insert(revealedRegionRow({ slug: pen.slug, name: "Stripfen", interior: false }));

  onConnect(ctx); // the world starts bare — a nuked preview world's shape

  const region = (r: any) => regionAt(Math.round(r.x), Math.round(r.y)).slug;
  const neighbor = capitalOf(1, 0).slug;
  assert.ok(ctx.db.boulder.rows().some((b: any) => region(b) === neighbor) || ctx.db.tree.rows().some((t: any) => region(t) === neighbor), "interior nodes healed");
  assert.ok(ctx.db.darkCreature.rows().some((c: any) => region(c) === pen.slug), "penumbra creatures healed");
  assert.equal(ctx.db.darkCreature.rows().some((c: any) => region(c) === neighbor), false, "interior kills stay dead — no creatures healed into claimed ground");
});


test("at dawn a resident stranded on claimed lit ground recedes to the nearest unlit tile", () => {
  const watcher = id("watcher");
  const ctx = makeCtx({ sender: watcher, random: 0.9, now: micros(1_000) }); // daytime
  ctx.db.player.insert(playerRow(watcher, { online: true, x: 0, y: 0 }));
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: true }); // the hearth region is lit
  const stray = ctx.db.darkCreature.insert(darkCreatureRow({ x: 71, y: 96 })); // a resident inside claimed ground

  wanderPresence(ctx, {});

  const after = ctx.db.darkCreature.id.find(stray.id);
  assert.ok(after, "residents recede, they don't despawn");
  assert.notEqual(regionAt(Math.round(after.x), Math.round(after.y)).slug, regionAt(69, 96).slug); // out of the lit region
});


test("a torch-bearer is not prey: creatures neither aggro nor keep chasing one", () => {
  const me = id("torchbearer");
  const ctx = makeCtx({ sender: me, random: 0.9 });
  const torch = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "torch", qty: 1, wear: 0 });
  ctx.db.player.insert(playerRow(me, { online: true, x: 69, y: 96, equippedOffHand: "torch", equippedOffHandInventoryId: torch.id }));
  // one creature beside the bearer, another already mid-chase from before the torch came out
  const fresh = ctx.db.darkCreature.insert(darkCreatureRow({ x: 70, y: 96 }));
  const chasing = ctx.db.darkCreature.insert(darkCreatureRow({ x: 72, y: 96, aggroTargetId: me.toHexString() }));

  wanderPresence(ctx, {});

  assert.equal(ctx.db.darkCreature.id.find(fresh.id)?.aggroTargetId, ""); // never acquired
  assert.equal(ctx.db.darkCreature.id.find(chasing.id)?.aggroTargetId, ""); // pursuit broken
  assert.equal(ctx.db.player.identity.find(me).health, PLAYER_MAX_HEALTH); // and no swings landed
});


test("a chase past the leash range is dropped — instinct stops pacing the fence", () => {
  const me = id("farprey");
  const ctx = makeCtx({ sender: me, random: 0.9 });
  ctx.db.player.insert(playerRow(me, { online: true, x: 69, y: 96 }));
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 69 + DARK_CREATURE_LEASH_RANGE + 2, y: 96, aggroTargetId: me.toHexString() }));

  wanderPresence(ctx, {});

  assert.equal(ctx.db.darkCreature.id.find(c.id)?.aggroTargetId, ""); // gave up
});

test("at night a hunting resident is marked strayed, and its death on lit ground sends it home", () => {
  const me = id("nightprey");
  const ctx = makeCtx({ sender: me, random: 0.9 });
  lockNight(ctx);
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: 69, y: 96, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: true });
  // prey and hunter both on the hearth region's claimed ground, outside the ring
  ctx.db.player.insert(playerRow(me, { online: true, x: 80, y: 96 }));
  const c = ctx.db.darkCreature.insert(darkCreatureRow({ x: 83, y: 96, aggroTargetId: me.toHexString() }));

  wanderPresence(ctx, {});
  const hunting = ctx.db.darkCreature.id.find(c.id);
  assert.equal(hunting?.aggroTargetId, me.toHexString()); // the hunt continues onto claimed ground
  assert.equal(hunting?.strayed, true);

  // killed in town: the corpse reaps back to the dark, not into permanence
  ctx.db.darkCreature.id.update({ ...hunting, health: 0, lastDamagedAt: { microsSinceUnixEpoch: 0n } });
  ctx.timestamp = { microsSinceUnixEpoch: micros(NPC_CORPSE_MS + 1000) };
  regenCreatures(ctx, {});
  const back = ctx.db.darkCreature.rows().filter((r: any) => !r.nightborn); // the tide also came in — filter to residents
  assert.equal(back.length, 1); // reverted, not deleted
  assert.notEqual(regionAt(Math.round(back[0].x), Math.round(back[0].y)).slug, regionAt(69, 96).slug); // back in the dark
  assert.equal(back[0].strayed, false);
});
