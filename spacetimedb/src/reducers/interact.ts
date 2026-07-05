import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import {
  EMBER_HEART_ITEM,
  getZone,
  isItemId,
  isStockpileItemId,
  ITEM_PICKUP_RADIUS,
  MAX_GROUND_ITEMS_PER_ZONE,
  spawnTile,
  tileKey,
} from "../../../shared/index";
import {
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  settle,
  solidTiles,
  addGroundItemTiles,
  addInventory,
  countRows,
  depositStockpile,
  nearestGroundItem,
  placeCarried,
  cardinal,
  tryIgniteBrazier,
} from "../helpers";

/**
 * Interact with nearby things (GDD "Interacting") — a generic action key (client
 * `E`). Empty-handed, pick up an adjacent ground item into inventory (or, for a
 * stockpile item, straight into the shared stockpile); already carrying, set it
 * back down on the faced tile. The faced direction is passed in because an idle
 * trogg's standing facing isn't synced (GDD "Movement"); the server still
 * re-derives the trogg's tile and only acts on adjacent targets, preferring the
 * faced tile when there are multiple candidates, so the client can't reach past
 * its neighbours (invariant 3).
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
    // Putting down a carried ember-heart on unlit ground with fuel banked
    // *delivers* it (GDD "Interacting" / "The fire and the dark" → Ignition):
    // it lights a nascent flame instead of landing as an inert ground item.
    if (p.carrying === EMBER_HEART_ITEM) {
      const ignited = tryIgniteBrazier(ctx, p, Math.round(pos.x), Math.round(pos.y));
      if (ignited) {
        ctx.db.player.identity.update({ ...p, x: pos.x, y: pos.y, carrying: "", carryingStyle: "" });
        return ignited;
      }
      // No qualifying site or stake: an ordinary put-down, same as any other
      // ground pickup — the ember-heart lands as a ground item, not a
      // carried world entity (it never had one, unlike a legacy boulder).
      if (countRows(ctx.db.groundItem.zoneId.filter(p.zoneId)) >= MAX_GROUND_ITEMS_PER_ZONE) return [];
      const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
      addGroundItemTiles(ctx, p.zoneId, occupied);
      const tile = spawnTile(zone, (x, y) => occupied.has(tileKey(x, y)), pos.x, pos.y, dir?.dirX ?? 0, dir?.dirY ?? 0);
      if (!tile) return [];
      ctx.db.groundItem.insert({ id: 0n, zoneId: p.zoneId, item: EMBER_HEART_ITEM, x: tile.x, y: tile.y, qty: 1 });
      ctx.db.player.identity.update({ ...p, x: pos.x, y: pos.y, carrying: "", carryingStyle: "" });
      return [{ distinctId: distinctId(ctx), event: "object_dropped", properties: { ...props, kind: EMBER_HEART_ITEM } }];
    }
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
    // A stockpile item (e.g. a debug-spawned stone) never reaches personal
    // inventory, even via this path — it deposits straight into the shared
    // stockpile, same as a gathered one (GDD "The fire and the dark").
    if (isStockpileItemId(item.item)) {
      depositStockpile(ctx, item.item, qty);
      ctx.db.groundItem.id.delete(item.id);
      return [];
    }
    // An ember-heart is carried, not inventoried (GDD "Interacting" / "The
    // fire and the dark" → Ignition) — the same tile-sized held-overlay
    // toggle a carried boulder once used, so a trogg can carry only one.
    if (item.item === EMBER_HEART_ITEM) {
      if (p.carrying !== "") return [];
      ctx.db.groundItem.id.delete(item.id);
      ctx.db.player.identity.update({ ...p, carrying: item.item, carryingStyle: "" });
      return [{ distinctId: distinctId(ctx), event: "object_picked_up", properties: { ...props, kind: item.item } }];
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

