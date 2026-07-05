import {
  INVENTORY_SLOT_COUNT,
  isEquippableItem,
  isItemId,
  isStockpileItemId,
  isStackableItem,
} from "../../shared/index";
import type { Ctx } from "./schema";

/** The player's owned inventory row by id, or undefined. */
export function ownedInventoryRow(ctx: Ctx, playerId: Ctx["sender"], id: bigint) {
  const row = ctx.db.inventory.id.find(id);
  return row && row.playerId.isEqual(playerId) ? row : undefined;
}

/** The specific inventory row currently equipped, with a fallback for pre-row-id rows. */
export function equippedInventoryRow(ctx: Ctx, p: { identity: Ctx["sender"]; equippedMainHand: string; equippedMainHandInventoryId: bigint }) {
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
export function removeInventoryUnit(ctx: Ctx, playerId: Ctx["sender"], inventoryId: bigint): { item: string; removedLastUnit: boolean } | undefined {
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
export function addInventory(ctx: Ctx, playerId: Ctx["sender"], item: string, qty: number): boolean {
  if (!isItemId(item) || isStockpileItemId(item) || qty <= 0) return false;
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

export function inventorySlotCount(ctx: Ctx, playerId: Ctx["sender"]): number {
  let count = 0;
  for (const _row of ctx.db.inventory.playerId.filter(playerId)) count++;
  return count;
}

export function hasFreeInventorySlot(ctx: Ctx, playerId: Ctx["sender"]): boolean {
  return inventorySlotCount(ctx, playerId) < INVENTORY_SLOT_COUNT;
}

/** Fold every inventory row from one identity into another, preserving item counts. */
export function moveInventory(ctx: Ctx, from: Ctx["sender"], to: Ctx["sender"]): Map<bigint, bigint> {
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

export function mergeInventoryForClaim(ctx: Ctx, playerId: Ctx["sender"], item: string, qty: number): bigint {
  for (const row of ctx.db.inventory.playerId.filter(playerId)) {
    if (row.item === item) {
      ctx.db.inventory.id.update({ ...row, qty: row.qty + qty });
      return row.id;
    }
  }
  return ctx.db.inventory.insert({ id: 0n, playerId, item, qty }).id;
}
