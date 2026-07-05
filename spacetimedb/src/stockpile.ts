import { STOCKPILE_CAP } from "../../shared/index";
import type { Ctx } from "./schema";

/**
 * Deposit into the tribe's shared stockpile (GDD "The fire and the dark" → The
 * stockpile): upserts the row for `item`, capped at `STOCKPILE_CAP` so a full
 * pool doesn't grow further. Returns the amount actually deposited (0 when
 * already at the cap), so a caller can tell a wasted gather from a real one.
 */
export function depositStockpile(ctx: Ctx, item: string, qty: number): number {
  if (qty <= 0) return 0;
  const row = ctx.db.stockpile.item.find(item);
  const before = row?.qty ?? 0;
  const after = Math.min(STOCKPILE_CAP, before + qty);
  const deposited = after - before;
  if (deposited <= 0) return 0;
  if (row) ctx.db.stockpile.item.update({ ...row, qty: after });
  else ctx.db.stockpile.insert({ item, qty: after });
  return deposited;
}
