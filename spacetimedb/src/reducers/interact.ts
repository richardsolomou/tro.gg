import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  getZone,
  isItemId,
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
  pickupTarget,
  nearestGroundItem,
  effectiveHogStyle,
  placeCarried,
  cardinal,
} from "../helpers";

/**
 * Interact with nearby things (GDD "Interacting") — a generic action key (client
 * `E`). Empty-handed, pick up an adjacent ground item into inventory or lift an
 * adjacent Hog onto the trogg (delete its world row, stamp `carrying`); already
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
    const properties: Record<string, string | number | boolean> = { ...props, kind };
    if (kind === "hog" && p.carryingStyle !== "") properties.style = p.carryingStyle;
    return [{ distinctId: distinctId(ctx), event: "object_dropped", properties }];
  }

  // Ground items are lifted by radius, not facing — the nearest one within
  // reach wins, so loot at your feet is always liftable (GDD "Interacting").
  const item = nearestGroundItem(ctx, p.zoneId, pos.x + 0.5, pos.y + 0.5, ITEM_PICKUP_RADIUS);
  if (item) {
    if (!isItemId(item.item)) return [];
    const qty = item.qty ?? 1;
    if (!addInventory(ctx, p.identity, item.item, qty)) return [];
    ctx.db.groundItem.id.delete(item.id);
    return [{ distinctId: distinctId(ctx), event: "inventory_item_acquired", properties: { ...props, item: item.item, qty } }];
  }

  const target = pickupTarget(ctx, p.zoneId, Math.round(pos.x), Math.round(pos.y), dir, ctx.timestamp);
  if (target?.kind === "hog") {
    const carryingStyle = effectiveHogStyle(target.row);
    ctx.db.hog.id.delete(target.row.id);
    ctx.db.player.identity.update({ ...p, carrying: "hog", carryingStyle });
    return [{ distinctId: distinctId(ctx), event: "object_picked_up", properties: { ...props, kind: "hog", style: carryingStyle } }];
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

