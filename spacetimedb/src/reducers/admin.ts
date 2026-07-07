import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import {
  capitalOf,
  cellOfSlug,
  getZone,
  isDarkCreatureSpecies,
  isDryFloor,
  isSpawnableItemId,
  neighborsOf,
  BOULDER_MAX_HEALTH,
  BRAZIER_LIT_RADIUS,
  TREE_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  MAX_DARK_CREATURES_PER_ZONE,
  MAX_GROUND_ITEMS_PER_ZONE,
  MAX_TREES_PER_ZONE,
  CHEAT_SPEED_MULTIPLIER,
  penumbraOf,
  PLAYER_MAX_HEALTH,
  nearestSafeTile,
  regionAt,
  STARTING_ZONE_SLUG,
  spawnTile,
  tileKey,
  type Zone,
} from "../../../shared/index";
import {
  spawnAt,
  seedBoulders,
  seedDarkCreatures,
  darkCreatureDef,
  isLitTile,
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  settle,
  countRows,
  solidTiles,
  addGroundItemTiles,
  facingDir,
  claimRegionAndExposePenumbra,
  exposeRegion,
  currentRevealedRegions,
  HEARTH_REGION_SLUG,
  revealGate,
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
  if (kind !== "boulder" && kind !== "tree" && kind !== "item" && kind !== "dark_creature") return [];
  if ((kind === "boulder" || kind === "tree") && item !== "") return [];
  if (kind === "item" && !isSpawnableItemId(item)) return [];
  if (kind === "dark_creature" && !isDarkCreatureSpecies(item)) return [];

  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  if (p.dead) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];

  const existing =
    kind === "boulder"
      ? [...ctx.db.boulder.zoneId.filter(p.zoneId)].filter((b) => !b.cellId).length
      : kind === "tree"
        ? countRows(ctx.db.tree.zoneId.filter(p.zoneId))
        : kind === "dark_creature"
          ? countRows(ctx.db.darkCreature.zoneId.filter(p.zoneId))
          : countRows(ctx.db.groundItem.zoneId.filter(p.zoneId));
  const cap = kind === "boulder" ? MAX_BOULDERS_PER_ZONE : kind === "tree" ? MAX_TREES_PER_ZONE : kind === "dark_creature" ? MAX_DARK_CREATURES_PER_ZONE : MAX_GROUND_ITEMS_PER_ZONE;
  if (existing >= cap) return [];

  // Drop entities on free floor — never inside a wall or on top of anything solid
  // (a boulder, a dark creature, or another trogg) or another pickup item. A
  // spawned dark creature additionally avoids lit ground — it can't occupy a
  // lit tile any more than a wandering one can (GDD "Dark creatures").
  const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  addGroundItemTiles(ctx, p.zoneId, occupied);
  const pos = settle(ctx, p, ctx.timestamp);
  const face = facingDir(p);
  const gate = revealGate(ctx, zone);
  const blocked =
    kind === "dark_creature"
      ? (x: number, y: number) => occupied.has(tileKey(x, y)) || isLitTile(ctx, p.zoneId, x, y) || gate(x, y)
      : (x: number, y: number) => occupied.has(tileKey(x, y)) || gate(x, y);
  const tile = spawnTile(zone, blocked, pos.x, pos.y, face.dirX, face.dirY);
  if (!tile) return [];

  if (kind === "boulder") {
    ctx.db.boulder.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, health: BOULDER_MAX_HEALTH, cellId: 0 });
  } else if (kind === "tree") {
    ctx.db.tree.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, health: TREE_MAX_HEALTH });
  } else if (kind === "dark_creature") {
    ctx.db.darkCreature.insert({
      id: 0n,
      zoneId: p.zoneId,
      x: tile.x,
      y: tile.y,
      dirX: 0,
      dirY: 0,
      movedAt: ctx.timestamp,
      species: item,
      health: darkCreatureDef(item).maxHealth,
      lastDamagedAt: ctx.timestamp,
      aggroTargetId: "",
      nightborn: false,
    });
  } else {
    ctx.db.groundItem.insert({ id: 0n, zoneId: p.zoneId, item, x: tile.x, y: tile.y, qty: 1 });
  }

  const properties: Record<string, string | number | boolean> = { zone: p.zoneId, kind, count: 1, ...sourceProp(source) };
  if (kind === "item") properties.item = item;
  if (kind === "dark_creature") properties.style = item;
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
  // warren rubble (cellId > 0) belongs to the birth cells, not the registry
  for (const b of [...ctx.db.boulder.zoneId.filter(zone.slug)]) {
    if (!b.cellId) ctx.db.boulder.id.delete(b.id);
  }
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
 * Reset the caller's zone dark creatures to their registry population (GDD
 * "Dark creatures") — the mirror of `resetBoulders`. Clears every dark
 * creature in the zone, corpse or living, and reseeds from the registry.
 */
function runResetDarkCreatures(ctx: Ctx, source = ""): AnalyticsEvent[] {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  const zone = getZone(p.zoneId);
  if (!zone) return [];
  for (const c of [...ctx.db.darkCreature.zoneId.filter(zone.slug)]) ctx.db.darkCreature.id.delete(c.id);
  seedDarkCreatures(ctx, zone);
  return [{ distinctId: distinctId(ctx), event: "dark_creatures_reset", properties: { zone: zone.slug, ...sourceProp(source) } }];
}

export const resetDarkCreatures = spacetimedb.reducer((ctx) => {
  runResetDarkCreatures(ctx);
});

export const resetDarkCreaturesAction = spacetimedb.procedure(
  { posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runResetDarkCreatures(tx, args.source));
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

/** Where a debug claim's brazier lands: the region's capital plaza — open
 *  floor by construction, so the shortcut never has to search. */
function regionAnchorTile(slug: string): { x: number; y: number } | undefined {
  const cell = cellOfSlug(slug);
  if (!cell) return undefined;
  const capital = capitalOf(cell.cellX, cell.cellY);
  return { x: capital.x, y: capital.y };
}

/**
 * Debug: claim one currently-penumbra region directly, skipping the usual
 * clear-the-zone requirement (GDD "Generation: only as far as the light
 * reaches" / "Territory and permanence") — for testing the frontier without
 * fighting anything. Inserts a lit brazier too, so the shortcut leaves the
 * same end state a real claim would. A no-op once every region is interior.
 */
/** Claim one region directly — brazier at its capital plaza, penumbra exposed —
 *  leaving the same end state a real claim would. */
function debugClaim(ctx: Ctx, zone: Zone, slug: string): boolean {
  const tile = regionAnchorTile(slug);
  if (!tile) return false;
  ctx.db.brazier.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y, radius: BRAZIER_LIT_RADIUS, lit: true, isEternal: false });
  claimRegionAndExposePenumbra(ctx, zone, slug);
  return true;
}

function runRevealNextRegion(ctx: Ctx, source = ""): AnalyticsEvent[] {
  const zone = getZone(STARTING_ZONE_SLUG);
  if (!zone) return [];
  const next = [...penumbraOf(currentRevealedRegions(ctx))].sort()[0];
  if (!next) return [];
  if (!debugClaim(ctx, zone, next)) return [];
  return [{ distinctId: distinctId(ctx), event: "region_revealed", properties: { region: next, ...sourceProp(source) } }];
}

export const revealNextRegion = spacetimedb.reducer((ctx) => {
  runRevealNextRegion(ctx);
});

/**
 * Debug: claim a chain of N regions directly outward from the current
 * frontier in one shot — "Reveal next region" repeated N times, each hop
 * preferring a neighbour of the region just claimed so the chain marches
 * away from the Hearth — for testing generation at genuine distance without
 * manually claiming hundreds of regions in sequence (GDD "Debug cheats").
 */
function runJumpRegions(ctx: Ctx, count: number, source = ""): AnalyticsEvent[] {
  const zone = getZone(STARTING_ZONE_SLUG);
  if (!zone) return [];
  const hops = Math.max(1, Math.min(200, Math.trunc(count)));
  let claimed = 0;
  let last: string | undefined;
  for (let i = 0; i < hops; i++) {
    const interior = currentRevealedRegions(ctx);
    const penumbra = penumbraOf(interior);
    let next: string | undefined;
    if (last) next = neighborsOf(last).find((slug) => penumbra.has(slug));
    next ??= [...penumbra].sort()[0];
    if (!next || !debugClaim(ctx, zone, next)) break;
    last = next;
    claimed++;
  }
  if (claimed === 0 || !last) return [];
  return [{ distinctId: distinctId(ctx), event: "frontier_jumped", properties: { regions: claimed, final_region: last, ...sourceProp(source) } }];
}

export const jumpRegions = spacetimedb.reducer({ count: t.i32() }, (ctx, { count }) => {
  runJumpRegions(ctx, count);
});

export const jumpRegionsAction = spacetimedb.procedure(
  { count: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runJumpRegions(tx, args.count, args.source));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

export const revealNextRegionAction = spacetimedb.procedure(
  { posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runRevealNextRegion(tx, args.source));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Debug: reset the frontier back to just the Hearth (GDD "Generation: only as
 * far as the light reaches"). Entities already seeded in now-unclaimed
 * regions are left in place — they're simply unreachable behind the reveal
 * gate again, exactly like a frontier no scout has found yet.
 */
function runResetFrontier(ctx: Ctx, source = ""): AnalyticsEvent[] {
  for (const row of [...ctx.db.revealedRegion.iter()]) {
    if (row.slug !== HEARTH_REGION_SLUG) ctx.db.revealedRegion.slug.delete(row.slug);
  }
  // claim braziers belong to the claims being forgotten; the First Fire stays
  for (const b of [...ctx.db.brazier.iter()]) {
    if (!b.isEternal) ctx.db.brazier.id.delete(b.id);
  }
  // re-expose the Hearth's own penumbra so its rows (and locked names) exist
  // again immediately; population guards make this a no-op for seeded ground
  const zone = getZone(STARTING_ZONE_SLUG);
  if (zone) {
    for (const neighborSlug of neighborsOf(HEARTH_REGION_SLUG)) exposeRegion(ctx, zone, neighborSlug, 1);
  }
  return [{ distinctId: distinctId(ctx), event: "frontier_reset", properties: { ...sourceProp(source) } }];
}

export const resetFrontier = spacetimedb.reducer((ctx) => {
  runResetFrontier(ctx);
});

export const resetFrontierAction = spacetimedb.procedure(
  { posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runResetFrontier(tx, args.source));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Pin (or release) the shared day-night cycle (GDD "Debug cheats"). The sky is
 * shared fiction — a scrubbed noon is noon for every client — so the override
 * lives in the public `world_state` singleton rather than any one client.
 * Phase is wrapped into [0, 1); live = the shared wall clock resumes.
 */
export const setSky = spacetimedb.reducer({ phase: t.f64(), locked: t.bool() }, (ctx, { phase, locked }) => {
  const wrapped = ((phase % 1) + 1) % 1;
  const existing = ctx.db.worldState.id.find(0);
  if (existing) ctx.db.worldState.id.update({ ...existing, skyLocked: locked, skyPhase: wrapped });
  else ctx.db.worldState.insert({ id: 0, skyLocked: locked, skyPhase: wrapped });
});
