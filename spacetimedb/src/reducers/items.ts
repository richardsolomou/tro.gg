import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  elapsedMs,
  EQUIPMENT_USE_COOLDOWN_MS,
  equipSlotOf,
  getZone,
  isEquippableItem,
  MAX_GROUND_ITEMS_PER_ZONE,
  spawnTile,
  weaponDamage,
  tileKey,
} from "../../../shared/index";
import {
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  settle,
  countRows,
  solidTiles,
  addGroundItemTiles,
  meleeBoulderTarget,
  meleeTreeTarget,
  meleeHogTarget,
  meleePlayerTarget,
  ownedInventoryRow,
  equippedInventoryRow,
  removeInventoryUnit,
  addInventory,
  playerDiedEvent,
  damageHog,
  damagePlayer,
  throwCarried,
  facingDir,
  directionVector,
} from "../helpers";

/**
 * Equip/unequip an owned item in its slot (GDD "Inventory"). Equipment references a
 * specific inventory row; it does not consume or move the item. Equipping the row that's
 * already in its slot toggles it off; `0` clears both hands. The reducer validates
 * ownership and routes to the item's slot (main or off hand) server-side.
 */
function runEquipItem(ctx: Ctx, { inventoryId, source = "" }: { inventoryId: bigint; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const unequipped = (item: string): AnalyticsEvent[] => [
    { distinctId: distinctId(ctx), event: "item_equipped", properties: { zone: p.zoneId, item, equipped: false, ...sourceProp(source) } },
  ];
  const equipped = (item: string): AnalyticsEvent[] => [
    { distinctId: distinctId(ctx), event: "item_equipped", properties: { zone: p.zoneId, item, equipped: true, ...sourceProp(source) } },
  ];

  if (inventoryId === 0n) {
    if (p.equippedMainHand === "" && p.equippedOffHand === "") return [];
    const item = p.equippedMainHand || p.equippedOffHand;
    ctx.db.player.identity.update({ ...p, equippedMainHand: "", equippedMainHandInventoryId: 0n, equippedOffHand: "", equippedOffHandInventoryId: 0n });
    return unequipped(item);
  }

  const row = ownedInventoryRow(ctx, p.identity, inventoryId);
  if (!row || row.qty <= 0 || !isEquippableItem(row.item)) return [];

  if (equipSlotOf(row.item) === "offHand") {
    if (p.equippedOffHandInventoryId === row.id) {
      ctx.db.player.identity.update({ ...p, equippedOffHand: "", equippedOffHandInventoryId: 0n });
      return unequipped(row.item);
    }
    ctx.db.player.identity.update({ ...p, equippedOffHand: row.item, equippedOffHandInventoryId: row.id });
    return equipped(row.item);
  }

  if (p.equippedMainHandInventoryId === row.id) {
    ctx.db.player.identity.update({ ...p, equippedMainHand: "", equippedMainHandInventoryId: 0n });
    return unequipped(row.item);
  }
  ctx.db.player.identity.update({ ...p, equippedMainHand: row.item, equippedMainHandInventoryId: row.id });
  return equipped(row.item);
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

/** Clear whichever hand was holding `inventoryId` — called when that row's last unit is removed. */
function unequipIfHeld(ctx: Ctx, inventoryId: bigint): void {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.equippedMainHandInventoryId === inventoryId) ctx.db.player.identity.update({ ...p, equippedMainHand: "", equippedMainHandInventoryId: 0n });
  else if (p.equippedOffHandInventoryId === inventoryId) ctx.db.player.identity.update({ ...p, equippedOffHand: "", equippedOffHandInventoryId: 0n });
}

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
  if (removed.removedLastUnit) unequipIfHeld(ctx, inventoryId);
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
  if (removed.removedLastUnit) unequipIfHeld(ctx, inventoryId);
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
 * carrying a Hog, `F` throws it as a tile-based impact weapon. Otherwise pickaxes
 * mine the nearest boulder in reach into one Stone inventory item, axes fell the
 * nearest tree into one Wood, and swords damage the nearest online trogg or Hog
 * in reach of the swing; at zero health the target dies.
 */
function runUseEquipped(ctx: Ctx, { dirX, dirY, source = "" }: { dirX: number; dirY: number; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (p.dead) return [];
  // The client sends its exact aim; throws and tile mechanics keep using the
  // dominant cardinal of it.
  const aim = directionVector(dirX, dirY);
  if (aim.dirX === 0 && aim.dirY === 0) return [];
  const dir = Math.abs(aim.dirX) >= Math.abs(aim.dirY) ? { dirX: Math.sign(aim.dirX), dirY: 0 } : { dirX: 0, dirY: Math.sign(aim.dirY) };

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
  // a fresh use inside the previous swing's cooldown is dropped (invariant 3)
  if (p.equipmentAction !== "" && elapsedMs(p.equipmentActionAt, ctx.timestamp) < EQUIPMENT_USE_COOLDOWN_MS) return [];

  // Melee resolves by reach and swing arc around the exact aim vector (shared
  // meleeHit), not tile adjacency — free movement means the eye judges reach in
  // world units. The server re-derives every position; nearest hit wins.
  // Tools take their gathering node first; any weapon with a damage number
  // wounds the nearest creature when no node claims the swing.
  const cx = pos.x + 0.5;
  const cy = pos.y + 0.5;
  let gathered = false;
  if (equipped.item === "pickaxe") {
    const b = meleeBoulderTarget(ctx, p.zoneId, cx, cy, aim);
    if (b && addInventory(ctx, p.identity, "stone", 1)) {
      ctx.db.boulder.id.delete(b.target.id);
      events.push({ distinctId: distinctId(ctx), event: "inventory_item_acquired", properties: { zone: p.zoneId, item: "stone", qty: 1, ...sourceProp(source) } });
      gathered = true;
    }
  } else if (equipped.item === "axe") {
    const tr = meleeTreeTarget(ctx, p.zoneId, cx, cy, aim);
    if (tr && addInventory(ctx, p.identity, "wood", 1)) {
      ctx.db.tree.id.delete(tr.target.id);
      events.push({ distinctId: distinctId(ctx), event: "inventory_item_acquired", properties: { zone: p.zoneId, item: "wood", qty: 1, ...sourceProp(source) } });
      gathered = true;
    }
  }
  const damage = weaponDamage(equipped.item);
  if (!gathered && damage > 0) {
    const trogg = meleePlayerTarget(ctx, p.zoneId, cx, cy, aim, ctx.timestamp, p.identity);
    const hog = meleeHogTarget(ctx, p.zoneId, cx, cy, aim, ctx.timestamp);
    if (trogg && (!hog || trogg.dist <= hog.dist)) {
      const result = damagePlayer(ctx, trogg.target, damage);
      events.push({ distinctId: distinctId(ctx), event: "combat_hit", properties: { ...props, weapon: equipped.item, target: "trogg", damage, killed: result.killed } });
      if (result.killed) events.push(playerDiedEvent(trogg.target.identity.toHexString(), props, equipped.item, result));
    } else if (hog) {
      const result = damageHog(ctx, hog.target, damage);
      events.push({ distinctId: distinctId(ctx), event: "combat_hit", properties: { ...props, weapon: equipped.item, target: "hog", damage, killed: result.killed } });
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

export const useEquippedAction = spacetimedb.procedure(
  { dirX: t.i32(), dirY: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runUseEquipped(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

