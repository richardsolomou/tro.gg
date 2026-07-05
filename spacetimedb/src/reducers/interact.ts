import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import {
  getZone,
  isItemId,
  isStockpileItemId,
  ITEM_PICKUP_RADIUS,
} from "../../../shared/index";
import {
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  settle,
  solidTiles,
  addInventory,
  nearestGroundItem,
  placeCarried,
  cardinal,
  depositStockpile,
} from "../helpers";

/**
 * Interact with nearby things (GDD "Interacting") — a generic action key (client
 * `E`). Empty-handed, pick up a nearby ground item into inventory; already
 * carrying, set it back down on the faced tile. The faced direction is
 * passed in because an idle trogg's standing facing isn't synced (GDD "Movement");
 * the server still re-derives the trogg's tile and only acts on adjacent targets,
 * preferring the faced tile when there are multiple candidates, so the client can't
 * reach past its neighbours (invariant 3).
 */
function runInteract(ctx: Ctx, { dirX, dirY, source = "" }: { dirX: number; dirY: number; source?: string }): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (p.dead) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];

  const dir = cardinal(dirX, dirY);
  const pos = settle(ctx, p, ctx.timestamp);
  const props = { zone: p.zoneId, ...sourceProp(source) };

  if (p.carrying !== "") {
    // Put down: place the held entity on the faced tile, or the nearest free
    // neighbour (spawnTile). A boxed-in trogg can't drop, so it keeps carrying.
    const kind = p.carrying;
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    const place = placeCarried(ctx, zone, p.carrying, p.carryingStyle, occupied, pos.x, pos.y, dir?.dirX ?? 0, dir?.dirY ?? 0);
    if (place) ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
    if (!place) return [];
    return [{ distinctId: distinctId(ctx), event: "object_dropped", properties: { ...props, kind } }];
  }

  // Ground items are lifted by radius, not facing — the nearest one within
  // reach wins, so loot at your feet is always liftable (GDD "Interacting").
  const item = nearestGroundItem(ctx, p.zoneId, pos.x + 0.5, pos.y + 0.5, ITEM_PICKUP_RADIUS);
  if (item) {
    if (!isItemId(item.item)) return [];
    const qty = item.qty ?? 1;
    if (isStockpileItemId(item.item)) {
      const deposit = depositStockpile(ctx, p.identity, item.item, qty);
      if (deposit.accepted <= 0) return [];
      if (deposit.accepted === qty) ctx.db.groundItem.id.delete(item.id);
      else ctx.db.groundItem.id.update({ ...item, qty: qty - deposit.accepted });
      return [{
        distinctId: distinctId(ctx),
        event: "resource_gathered",
        properties: { ...props, node_type: "ground_item", item: item.item, qty: deposit.accepted, deposited_qty: deposit.accepted, stockpile_total: deposit.total, stockpile_full: deposit.full },
      }];
    }
    if (!addInventory(ctx, p.identity, item.item, qty)) return [];
    ctx.db.groundItem.id.delete(item.id);
    return [{ distinctId: distinctId(ctx), event: "inventory_item_acquired", properties: { ...props, item: item.item, qty } }];
  }

  return [];
}

export const interact = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32() }, (ctx, args) => {
  runInteract(ctx, args);
});

export const interactAction = spacetimedb.procedure(
  { dirX: t.i32(), dirY: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runInteract(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);
