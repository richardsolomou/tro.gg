import { ScheduleAt } from "spacetimedb";
import {
  BRAZIER_UPKEEP_INTERVAL_MS,
  BRAZIER_UPKEEP_ITEM,
  BRAZIER_UPKEEP_RATE,
  FIRST_FIRE_RADIUS,
  STARTING_ZONE_SLUG,
  getZone,
  litTileKeys,
} from "../../shared/index";
import type { Ctx } from "./schema";
import { consumeStockpileItem } from "./stockpile";

export function ensureFirstFire(ctx: Ctx): void {
  const at = getZone(STARTING_ZONE_SLUG)?.spawn;
  if (!at) return;
  const eternal = [...ctx.db.brazier.iter()]
    .filter((row) => row.isEternal)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const first = eternal[0];
  const row = {
    id: first?.id ?? 0n,
    zoneId: STARTING_ZONE_SLUG,
    x: at.x,
    y: at.y,
    radius: FIRST_FIRE_RADIUS,
    lit: true,
    isEternal: true,
  };
  if (!first) ctx.db.brazier.insert(row);
  else if (
    first.zoneId !== row.zoneId ||
    first.x !== row.x ||
    first.y !== row.y ||
    first.radius !== row.radius ||
    !first.lit
  ) {
    ctx.db.brazier.id.update(row);
  }
  for (const duplicate of eternal.slice(1)) ctx.db.brazier.id.delete(duplicate.id);
}

export function brazierLightTiles(ctx: Ctx, zoneId: string): Set<string> {
  const zone = getZone(zoneId);
  if (!zone) return new Set();
  return litTileKeys(ctx.db.brazier.zoneId.filter(zoneId), zoneId, zone.width, zone.height);
}

export function armBrazierUpkeep(ctx: Ctx): void {
  if (ctx.db.brazierUpkeep.count() > 0n) return;
  if (![...ctx.db.brazier.iter()].some((row) => row.lit && !row.isEternal)) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(BRAZIER_UPKEEP_INTERVAL_MS) * 1000n;
  ctx.db.brazierUpkeep.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

export interface BrazierUpkeepResult {
  charged: number;
  guttered: bigint[];
  remainingLit: number;
}

export function runBrazierUpkeep(ctx: Ctx): BrazierUpkeepResult {
  ensureFirstFire(ctx);
  const first = [...ctx.db.brazier.iter()].find((row) => row.isEternal);
  const lit = [...ctx.db.brazier.iter()]
    .filter((row) => row.lit && !row.isEternal)
    .sort((a, b) => {
      const da = first ? Math.hypot(a.x - first.x, a.y - first.y) : 0;
      const db = first ? Math.hypot(b.x - first.x, b.y - first.y) : 0;
      if (da !== db) return db - da;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  const available = Math.max(0, ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM)?.qty ?? 0);
  const affordable = Math.min(lit.length, Math.floor(available / BRAZIER_UPKEEP_RATE));
  const guttered = lit.slice(0, lit.length - affordable);
  for (const row of guttered) ctx.db.brazier.id.update({ ...row, lit: false });
  const remainingLit = lit.length - guttered.length;
  const charged = consumeStockpileItem(ctx, BRAZIER_UPKEEP_ITEM, remainingLit * BRAZIER_UPKEEP_RATE);
  return { charged, guttered: guttered.map((row) => row.id), remainingLit };
}
