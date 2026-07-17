import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import { BRAZIER_CLAIM_STONE_COST, BRAZIER_LIT_RADIUS, getZone, isItemId, ITEM_PICKUP_RADIUS, penumbraOf, regionAt, spawnTile, tileKey } from "../../../shared/index";
import {
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  settle,
  solidTiles,
  addInventory,
  claimRegionAndExposePenumbra,
  withdrawStockpile,
  currentRevealedRegions,
  livingDarkCreaturesInRegion,
  nearestGroundItem,
  placeCarried,
  cardinal,
} from "../helpers";

/**
 * Interact with nearby things (GDD "Interacting") — a generic action key
 * (client `E`). Empty-handed: relight an adjacent guttered brazier for free,
 * or — standing in a penumbra region with every one of its dark creatures
 * dead — set a new brazier down and claim the region (GDD "Territory and
 * permanence"); failing either of those, pick up a ground item. Already
 * carrying something, set it back down on the faced tile. The faced
 * direction is passed in because an idle trogg's standing facing isn't
 * synced (GDD "Movement"); the server still re-derives the trogg's tile and
 * only acts on adjacent targets, so the client can't reach past its
 * neighbours (invariant 3).
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
    return [{ distinctId: distinctId(ctx), event: "object_dropped", properties }];
  }

  const px = Math.round(pos.x);
  const py = Math.round(pos.y);

  // Relighting an existing guttered brazier is always free — the region
  // stayed claimed the whole time it was dark (GDD "Territory and permanence").
  const guttered = [...ctx.db.brazier.zoneId.filter(p.zoneId)].find((b) => !b.isEternal && !b.lit && Math.hypot(b.x - px, b.y - py) <= 1);
  if (guttered) {
    ctx.db.brazier.id.update({ ...guttered, lit: true });
    return [{ distinctId: distinctId(ctx), event: "brazier_relit", properties: props }];
  }

  // Standing in a penumbra region with nothing left alive in it: set a new
  // brazier down and claim the region (GDD "Generation: only as far as the
  // light reaches" / "Territory claiming") — clearing it is what buys the
  // right to claim; the brazier itself is paid in stone from the stockpile,
  // so expansion is a tribe-level economic decision.
  const slug = regionAt(px, py)?.slug;
  if (slug && penumbraOf(currentRevealedRegions(ctx)).has(slug) && livingDarkCreaturesInRegion(ctx, p.zoneId, slug) === 0) {
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), px, py, dir?.dirX ?? 0, dir?.dirY ?? 0);
    if (tile && withdrawStockpile(ctx, "stone", BRAZIER_CLAIM_STONE_COST)) {
      ctx.db.brazier.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
      claimRegionAndExposePenumbra(ctx, zone, slug);
      return [{ distinctId: distinctId(ctx), event: "region_claimed", properties: { ...props, region: slug, stone_cost: BRAZIER_CLAIM_STONE_COST } }];
    }
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

