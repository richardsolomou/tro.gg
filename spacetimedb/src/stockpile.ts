import { isStockpileItemId, STOCKPILE_CAP } from "../../shared/index";
import type { Ctx } from "./schema";

export interface StockpileDeposit {
  accepted: number;
  itemQty: number;
  total: number;
  full: boolean;
}

export function stockpileTotal(ctx: Ctx): number {
  let total = 0;
  for (const row of ctx.db.stockpile.iter()) total += row.qty;
  return total;
}

export function depositStockpile(ctx: Ctx, playerId: Ctx["sender"], item: string, qty: number): StockpileDeposit {
  const before = stockpileTotal(ctx);
  if (!isStockpileItemId(item) || qty <= 0) {
    return { accepted: 0, itemQty: ctx.db.stockpile.item.find(item)?.qty ?? 0, total: before, full: before >= STOCKPILE_CAP };
  }

  const accepted = Math.min(Math.floor(qty), Math.max(0, STOCKPILE_CAP - before));
  const existing = ctx.db.stockpile.item.find(item);
  const itemQty = (existing?.qty ?? 0) + accepted;
  if (accepted > 0) {
    if (existing) ctx.db.stockpile.item.update({ ...existing, qty: itemQty });
    else ctx.db.stockpile.insert({ item, qty: itemQty });

    const contribution = [...ctx.db.stockpileContribution.playerId.filter(playerId)].find((row) => row.item === item);
    if (contribution) ctx.db.stockpileContribution.id.update({ ...contribution, qty: contribution.qty + accepted });
    else ctx.db.stockpileContribution.insert({ id: 0n, playerId, item, qty: accepted });
  }

  const total = before + accepted;
  return { accepted, itemQty, total, full: total >= STOCKPILE_CAP };
}

export function consumeStockpileItem(ctx: Ctx, item: string, qty: number): number {
  const row = ctx.db.stockpile.item.find(item);
  const consumed = Math.min(Math.max(0, Math.floor(qty)), Math.max(0, row?.qty ?? 0));
  if (!row || consumed === 0) return 0;
  const remaining = row.qty - consumed;
  if (remaining > 0) ctx.db.stockpile.item.update({ ...row, qty: remaining });
  else ctx.db.stockpile.item.delete(item);
  return consumed;
}

export function migrateInventoryResources(ctx: Ctx): void {
  for (const row of [...ctx.db.inventory.iter()]) {
    if (!isStockpileItemId(row.item)) continue;
    depositStockpile(ctx, row.playerId, row.item, row.qty);
    ctx.db.inventory.id.delete(row.id);
  }
}

export function moveStockpileContributions(ctx: Ctx, from: Ctx["sender"], to: Ctx["sender"]): void {
  for (const row of [...ctx.db.stockpileContribution.playerId.filter(from)]) {
    const target = [...ctx.db.stockpileContribution.playerId.filter(to)].find((candidate) => candidate.item === row.item);
    if (target) ctx.db.stockpileContribution.id.update({ ...target, qty: target.qty + row.qty });
    else ctx.db.stockpileContribution.insert({ id: 0n, playerId: to, item: row.item, qty: row.qty });
    ctx.db.stockpileContribution.id.delete(row.id);
  }
}
