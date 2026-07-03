import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  getZone,
  isHogStyle,
  isSpawnableItemId,
  hogMaxHealth,
  HOG_MAX_HEALTH,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  MAX_GROUND_ITEMS_PER_ZONE,
  MAX_HOGS_PER_ZONE,
  MAX_TREES_PER_ZONE,
  CHEAT_SPEED_MULTIPLIER,
  PLAYER_MAX_HEALTH,
  nearestSafeTile,
  spawnTile,
  tileKey,
} from "../../../shared/index";
import {
  spawnAt,
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
    ctx.db.boulder.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, health: BOULDER_MAX_HEALTH });
  } else if (kind === "tree") {
    ctx.db.tree.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, health: TREE_MAX_HEALTH });
  } else if (kind === "hog") {
    // A spawned Hog starts at rest and joins the roamers — the next wander tick
    // gives it a heading like any other. `item` carries an explicit sprite style.
    ctx.db.hog.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: tile.x, homeY: tile.y, style: item, health: hogMaxHealth(item), lastDamagedAt: Timestamp.UNIX_EPOCH });
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


/**
 * Debug cheats (GDD "Commands panel"): a move-speed multiplier, flight (hover;
 * altitude is client display state), noclip (walk through anything), and
 * invulnerability, toggled from the Commands panel. Motion settles first — a
 * speed or noclip change re-derives position from the origin, so an unsettled
 * intent would replay its history at the new rules and teleport (the same
 * reason `move` settles before storing a new heading). Values are clamped,
 * never trusted (invariant 3): speed only 1 or the fixed multiplier, and a
 * trogg switching noclip off while inside geometry settles to the nearest safe
 * tile so it can't end up standing inside a wall.
 */
export const setCheats = spacetimedb.reducer({ speed: t.f64(), fly: t.bool(), noclip: t.bool(), invulnerable: t.bool() }, (ctx, { speed, fly, noclip, invulnerable }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;
  const settled = settle(ctx, p, ctx.timestamp);
  let at = { x: settled.x, y: settled.y };
  if ((p.cheatNoclip && !noclip) || (p.cheatFly && !fly)) {
    // touching down / re-clipping: airborne or noclipped projection ignored
    // walkability, so the settled spot may be a wall or water — step to the
    // nearest standable ground
    const tile = nearestSafeTile(zone, Math.round(at.x), Math.round(at.y));
    if (tile) at = tile;
  }
  ctx.db.player.identity.update({
    ...p,
    x: at.x,
    y: at.y,
    // grounding: switching fly off drops the trogg; staying airborne keeps the
    // settled altitude and stops the climb (a fresh Space press resumes it)
    z: fly ? settled.z : 0,
    dirZ: 0,
    dirX: 0,
    dirY: 0,
    path: "",
    movedAt: ctx.timestamp,
    cheatSpeed: speed > 1 ? CHEAT_SPEED_MULTIPLIER : 1,
    cheatFly: fly,
    cheatInvulnerable: invulnerable,
    cheatNoclip: noclip,
  });
});

/**
 * The fly cheat's vertical intent (GDD "Debug cheats"): -1 sinking, 0 holding,
 * +1 climbing — written on Space/C input transitions, exactly the `move`
 * pattern for the third axis. Settles first so elapsed climb at the old lift
 * isn't lost or replayed; sign-clamped, never trusted (invariant 3). Ignored
 * unless the flyer is airborne (cheatFly).
 */
export const setLift = spacetimedb.reducer({ dirZ: t.i32() }, (ctx, { dirZ }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead || !p.cheatFly) return;
  const settled = settle(ctx, p, ctx.timestamp);
  // a click-route's stored waypoints aren't trimmed by the settle; re-basing the
  // origin under the full path would glide the trogg backward, so the route ends
  ctx.db.player.identity.update({
    ...p,
    x: settled.x,
    y: settled.y,
    z: settled.z,
    dirZ: Math.sign(dirZ),
    path: "",
    movedAt: ctx.timestamp,
  });
});

/**
 * Debug/alpha escape hatch (GDD "Debug cheats"): restore full health. A dead
 * trogg stays dead — respawn already handles that; this is for walking away
 * from a botched fight while testing.
 */
export const healSelf = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  ctx.db.player.identity.update({ ...p, health: PLAYER_MAX_HEALTH });
});

/**
 * Debug/alpha escape hatch (GDD "Debug cheats"): unstuck. Settle, then step to
 * the nearest standable tile — or all the way back to spawn when nothing nearby
 * is safe — grounding and stopping the trogg. The way out of any weird spot a
 * tester locks themselves into.
 */
export const rescue = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;
  const settled = settle(ctx, p, ctx.timestamp);
  const at = nearestSafeTile(zone, Math.round(settled.x), Math.round(settled.y)) ?? spawnAt(zone);
  ctx.db.player.identity.update({
    ...p,
    x: at.x,
    y: at.y,
    z: 0,
    dirZ: 0,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    movedAt: ctx.timestamp,
  });
});
