import { isItemId, STOCKPILE_CAP } from "../../shared/index";
import type { Ctx } from "./schema";

/**
 * Deposit into the tribe's shared stockpile (GDD "The fire and the dark" →
 * The stockpile), clamped at `STOCKPILE_CAP` — a full pool simply absorbs less
 * than `qty`, never more than the cap. Returns the amount actually deposited.
 */
export function depositStockpile(ctx: Ctx, item: string, qty: number): number {
  if (!isItemId(item) || qty <= 0) return 0;
  const row = ctx.db.stockpile.item.find(item);
  const have = row?.qty ?? 0;
  const added = Math.max(0, Math.min(qty, STOCKPILE_CAP - have));
  if (added <= 0) return 0;
  if (row) ctx.db.stockpile.item.update({ ...row, qty: have + added });
  else ctx.db.stockpile.insert({ item, qty: added });
  return added;
}
