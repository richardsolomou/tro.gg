import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  getZone,
  IGNITION_FLAME_HEALTH,
  IGNITION_FUEL_COST,
  IGNITION_WINDOW_MS,
  isDryFloor,
  isItemId,
  ITEM_PICKUP_RADIUS,
  penumbraOf,
  regionAt,
} from "../../../shared/index";
import {
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  settle,
  solidTiles,
  addInventory,
  addMs,
  currentRevealedRegions,
  nearestGroundItem,
  nearbyEmberHeart,
  placeCarried,
  isLitTile,
  withdrawStockpile,
  cardinal,
} from "../helpers";

/**
 * Interact with nearby things (GDD "Interacting") — a generic action key (client
 * `E`). Empty-handed, pick up an adjacent ember-heart or ground item into
 * inventory; already carrying, set it back down on the faced tile — or, an
 * ember-heart facing a valid unclaimed site with fuel to spare, light an
 * ignition instead (GDD "The fire and the dark" → Ignition). The faced
 * direction is passed in because an idle trogg's standing facing isn't synced
 * (GDD "Movement"); the server still re-derives the trogg's tile and only acts
 * on adjacent targets, preferring the faced tile when there are multiple
 * candidates, so the client can't reach past its neighbours (invariant 3).
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
    if (p.carrying === "ember_heart") {
      const siteX = Math.round(pos.x) + (dir?.dirX ?? 0);
      const siteY = Math.round(pos.y) + (dir?.dirY ?? 0);
      const claimed = [...ctx.db.project.zoneId.filter(p.zoneId)].some((pr) => pr.status === "active" && Math.hypot(pr.x - siteX, pr.y - siteY) <= 1);
      // Pushing the frontline means igniting where the dark still holds: a
      // brand-new site must be in the penumbra. Relighting an existing
      // guttered brazier stays allowed anywhere already interior — the
      // "cheap to relight" behaviour is unchanged (GDD "Generation: only as
      // far as the light reaches" / "Territory and permanence").
      const relighting = [...ctx.db.brazier.zoneId.filter(p.zoneId)].some((b) => !b.isEternal && !b.lit && Math.hypot(b.x - siteX, b.y - siteY) <= 1);
      const revealedSlugs = currentRevealedRegions(ctx);
      const siteSlug = regionAt(siteX, siteY)?.slug;
      const inFrontier = !!siteSlug && (relighting ? revealedSlugs.has(siteSlug) : penumbraOf(revealedSlugs).has(siteSlug));
      const validSite = isDryFloor(zone, siteX, siteY) && !isLitTile(ctx, p.zoneId, siteX, siteY) && !claimed && inFrontier;
      if (validSite && withdrawStockpile(ctx, "wood", IGNITION_FUEL_COST)) {
        ctx.db.project.insert({
          id: 0n,
          zoneId: p.zoneId,
          x: siteX,
          y: siteY,
          status: "active",
          flameHealth: IGNITION_FLAME_HEALTH,
          windowEndsAt: addMs(ctx.timestamp, IGNITION_WINDOW_MS),
          // Far enough in the past that the very next wander sweep spawns
          // the first wave — the dark answers right away, not after a wait.
          lastWaveAt: Timestamp.UNIX_EPOCH,
        });
        ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
        return [{ distinctId: distinctId(ctx), event: "project_contributed", properties: { ...props, project: "ignition", item: "ember_heart", qty: 1 } }];
      }
    }

    // Put down: place the held entity on the faced tile, or the nearest free
    // neighbour (spawnTile). A boxed-in trogg can't drop, so it keeps carrying.
    const kind = p.carrying;
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    const place = placeCarried(ctx, zone, p.carrying, p.carryingStyle, occupied, pos.x, pos.y, dir?.dirX ?? 0, dir?.dirY ?? 0);
    if (place) ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
    if (!place) return [];
    const properties: Record<string, string | number | boolean> = { ...props, kind };
    return [{ distinctId: distinctId(ctx), event: "object_dropped", properties }];
  }

  // An adjacent ember-heart is a carryable, not inventory (GDD "Interacting"):
  // scanned by facing first, the same as the retired boulder carry.
  const heart = nearbyEmberHeart(ctx, p.zoneId, Math.round(pos.x), Math.round(pos.y), dir?.dirX ?? 0, dir?.dirY ?? 0);
  if (heart) {
    ctx.db.emberHeart.id.delete(heart.id);
    ctx.db.player.identity.update({ ...p, carrying: "ember_heart", carryingStyle: "" });
    return [{ distinctId: distinctId(ctx), event: "object_picked_up", properties: { ...props, kind: "ember_heart" } }];
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

