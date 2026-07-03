import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  getZone,
  isHogStyle,
  isSpawnableItemId,
  HOG_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  MAX_GROUND_ITEMS_PER_ZONE,
  MAX_HOGS_PER_ZONE,
  MAX_TREES_PER_ZONE,
  spawnTile,
  tileKey,
} from "../../../shared/index";
import {
  seedBoulders,
  seedHogs,
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  settle,
  countRows,
  solidTiles,
  addGroundItemTiles,
  facingDir,
} from "../helpers";

/**
 * Spawn one thing at the caller's location from the pre-alpha Commands panel
 * (optionally gated client-side by `spawn-command`). The server re-derives the
 * trogg's tile authoritatively (invariant 3) and places the thing on a nearby free
 * tile, starting with the tile it faces, so nothing lands inside a wall or on
 * another entity. Refused once the zone is at its cap, so a scripted client can't
 * flood it (the client flag only gates the UI). An unknown kind/item, a full zone,
 * or a boxed-in trogg is a silent no-op.
 */
function runSpawn(ctx: Ctx, { kind, item = "", source = "" }: { kind: string; item?: string; source?: string }): AnalyticsEvent[] {
  if (kind !== "boulder" && kind !== "tree" && kind !== "hog" && kind !== "item") return [];
  if ((kind === "boulder" || kind === "tree") && item !== "") return [];
  if (kind === "item" && !isSpawnableItemId(item)) return [];
  if (kind === "hog" && item !== "" && !isHogStyle(item)) return [];

  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (p.dead) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];

  const existing =
    kind === "boulder"
      ? countRows(ctx.db.boulder.zoneId.filter(p.zoneId))
      : kind === "tree"
        ? countRows(ctx.db.tree.zoneId.filter(p.zoneId))
        : kind === "hog"
          ? countRows(ctx.db.hog.zoneId.filter(p.zoneId))
          : countRows(ctx.db.groundItem.zoneId.filter(p.zoneId));
  const cap = kind === "boulder" ? MAX_BOULDERS_PER_ZONE : kind === "tree" ? MAX_TREES_PER_ZONE : kind === "hog" ? MAX_HOGS_PER_ZONE : MAX_GROUND_ITEMS_PER_ZONE;
  if (existing >= cap) return [];

  // Drop entities on free floor — never inside a wall or on top of anything solid
  // (a boulder, a Hog, or another trogg) or another pickup item.
  const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  addGroundItemTiles(ctx, p.zoneId, occupied);
  const pos = settle(ctx, p, ctx.timestamp);
  const face = facingDir(p);
  const tile = spawnTile(zone, (x, y) => occupied.has(tileKey(x, y)), pos.x, pos.y, face.dirX, face.dirY);
  if (!tile) return [];

  if (kind === "boulder") {
    ctx.db.boulder.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y });
  } else if (kind === "tree") {
    ctx.db.tree.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y });
  } else if (kind === "hog") {
    // A spawned Hog starts at rest and joins the roamers — the next wander tick
    // gives it a heading like any other. `item` carries an explicit sprite style.
    ctx.db.hog.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: tile.x, homeY: tile.y, style: item, health: HOG_MAX_HEALTH });
  } else {
    ctx.db.groundItem.insert({ id: 0n, zoneId: p.zoneId, item, x: tile.x, y: tile.y, qty: 1 });
  }

  const properties: Record<string, string | number | boolean> = { zone: p.zoneId, kind, count: 1, ...sourceProp(source) };
  if (kind === "item") properties.item = item;
  if (kind === "hog" && item !== "") properties.style = item;
  return [{ distinctId: distinctId(ctx), event: "debug_entity_spawned", properties }];
}

export const spawn = spacetimedb.reducer({ kind: t.string(), item: t.string() }, (ctx, args) => {
  runSpawn(ctx, args);
});

export const spawnAction = spacetimedb.procedure(
  { kind: t.string(), item: t.string(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runSpawn(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Reset the caller's zone boulders to their `ZONES` registry positions (GDD
 * "Boulders"). Clears the zone's boulders and reseeds from the registry — the single
 * source of truth — so a layout shoved out of shape snaps back. Fired by the Commands
 * panel; open like every reducer, with the optional `boulder-reset` flag gating the
 * client control.
 */
function runResetBoulders(ctx: Ctx, source = ""): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];
  for (const b of [...ctx.db.boulder.zoneId.filter(zone.slug)]) ctx.db.boulder.id.delete(b.id);
  seedBoulders(ctx, zone);
  return [{ distinctId: distinctId(ctx), event: "boulders_reset", properties: { zone: zone.slug, ...sourceProp(source) } }];
}

export const resetBoulders = spacetimedb.reducer((ctx) => {
  runResetBoulders(ctx);
});

export const resetBouldersAction = spacetimedb.procedure(
  { posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runResetBoulders(tx, args.source));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Reset the caller's zone Hogs to their `ZONES` registry population (GDD "Hogs").
 * Clears the zone's Hogs and reseeds from the registry — the single source of
 * truth — so a zone overrun with extra panel-spawned Hogs snaps back to its intended
 * count. The mirror of `resetBoulders`. A Hog a trogg is carrying lives on the
 * player row, not the `hog` table, so it survives the cull and re-materialises on
 * put-down (GDD "Interacting"). Fired by the Commands panel; open like every reducer,
 * with the optional `hog-reset` flag gating the client control.
 */
function runResetHogs(ctx: Ctx, source = ""): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];
  for (const h of [...ctx.db.hog.zoneId.filter(zone.slug)]) ctx.db.hog.id.delete(h.id);
  seedHogs(ctx, zone);
  return [{ distinctId: distinctId(ctx), event: "hedgehogs_reset", properties: { zone: zone.slug, ...sourceProp(source) } }];
}

export const resetHogs = spacetimedb.reducer((ctx) => {
  runResetHogs(ctx);
});

export const resetHogsAction = spacetimedb.procedure(
  { posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runResetHogs(tx, args.source));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

