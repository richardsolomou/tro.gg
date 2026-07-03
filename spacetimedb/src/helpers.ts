import { ScheduleAt } from "spacetimedb";
import {
  GHOST_HAUNT_HISTORY_MAX,
  HOG_IDLE_CHANCE,
  HOG_STEP_INTERVAL_MS,
  HOG_TURN_CHANCE,
  isValidName,
  isWalkable,
  HOG_MAX_HEALTH,
  SPACETIMEAUTH_ISSUER,
  walkableCardinals,
  type Zone,
  type ZoneBounds,
} from "../../shared/index";
import { countRows } from "./tiles";
import type { Ctx, ProcCtx, AnalyticsEvent } from "./schema";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";

export function captureProcedureEvents(ctx: ProcCtx, posthogKey: string, events: AnalyticsEvent | AnalyticsEvent[] | undefined): void {
  const key = posthogKey.trim();
  if (!key) return;
  const batch = Array.isArray(events) ? events : events ? [events] : [];
  for (const item of batch) {
    try {
      ctx.http.fetch(POSTHOG_CAPTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          event: item.event,
          distinct_id: item.distinctId,
          properties: {
            ...item.properties,
            source: item.properties?.source ?? "spacetimedb-procedure",
          },
        }),
      });
    } catch {
      // Telemetry is best-effort and must never roll back an accepted gameplay action.
    }
  }
}

export function sourceProp(source: string): Record<string, string> {
  const trimmed = source.trim();
  return trimmed ? { source: trimmed.slice(0, 64) } : {};
}

export function distinctId(ctx: Ctx): string {
  return ctx.sender.toHexString();
}

export function unit(): {} {
  return {};
}

/**
 * Regenerating the committed world map under a live database leaves rows seeded
 * from the old layout sitting inside the new map's rock — visibly embedded in
 * walls, and poisoning collision (a hog projected from inside rock makes the
 * client and server disagree about blocked tiles). Detect any seedable row on
 * unwalkable ground and wipe the zone's boulders, Hogs, and ground items; the
 * idempotent seeders right after then re-seed from the current map.
 */
export function healStaleWorld(ctx: Ctx, zone: Zone): void {
  const boulders = [...ctx.db.boulder.zoneId.filter(zone.slug)];
  const trees = [...ctx.db.tree.zoneId.filter(zone.slug)];
  const hogs = [...ctx.db.hog.zoneId.filter(zone.slug)];
  const items = [...ctx.db.groundItem.zoneId.filter(zone.slug)];
  const stale =
    boulders.some((b) => !isWalkable(zone, b.x, b.y)) ||
    trees.some((tr) => !isWalkable(zone, tr.x, tr.y)) ||
    hogs.some((h) => !isWalkable(zone, Math.round(h.x), Math.round(h.y))) ||
    items.some((g) => !isWalkable(zone, g.x, g.y));
  if (!stale) return;
  for (const b of boulders) ctx.db.boulder.id.delete(b.id);
  for (const tr of trees) ctx.db.tree.id.delete(tr.id);
  for (const h of hogs) ctx.db.hog.id.delete(h.id);
  for (const g of items) ctx.db.groundItem.id.delete(g.id);
}

/** Seed a zone's boulders from the registry, unless it already has some. */
export function seedBoulders(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.boulder.zoneId.filter(zone.slug)].length > 0) return;
  for (const b of zone.boulders) {
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: b.x, y: b.y });
  }
}

/** Seed a zone's trees from the registry, unless it already has some. */
export function seedTrees(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.tree.zoneId.filter(zone.slug)].length > 0) return;
  for (const tr of zone.trees) {
    ctx.db.tree.insert({ id: 0n, zoneId: zone.slug, x: tr.x, y: tr.y });
  }
}

/** Seed a zone's Hogs from the registry, unless it already has some — the common
 *  roamers (style "" → client-derived skin) and the rare 2×2 showpieces (explicit
 *  style, so `hogSize` makes them big). */
export function seedHogs(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.hog.zoneId.filter(zone.slug)].length > 0) return;
  for (const h of zone.hogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: "", health: HOG_MAX_HEALTH });
  }
  for (const h of zone.bigHogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: h.style, health: HOG_MAX_HEALTH });
  }
}

/** Seed a zone's starter pickup items from the registry, unless it already has some. */
export function seedGroundItems(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.groundItem.zoneId.filter(zone.slug)].length > 0) return;
  for (const item of zone.items) {
    ctx.db.groundItem.insert({ id: 0n, zoneId: zone.slug, item: item.item, x: item.x, y: item.y, qty: 1 });
  }
}

/** Whether any player is currently online — the Hogs only roam while someone is
 *  watching (invariant 1: an empty zone does no work). */
export function anyPlayerOnline(ctx: Ctx): boolean {
  for (const p of ctx.db.player.iter()) if (p.online) return true;
  return false;
}

export function playerConnectionCount(ctx: Ctx, playerId: Ctx["sender"]): number {
  return countRows(ctx.db.playerConnection.playerId.filter(playerId));
}

export function rememberPlayerConnection(ctx: Ctx): void {
  if (!ctx.connectionId) return;
  const connectionId = ctx.connectionId.toHexString();
  if (ctx.db.playerConnection.connectionId.find(connectionId)) return;
  ctx.db.playerConnection.insert({ connectionId, playerId: ctx.sender, connectedAt: ctx.timestamp });
}

export function forgetPlayerConnection(ctx: Ctx): number {
  if (ctx.connectionId) ctx.db.playerConnection.connectionId.delete(ctx.connectionId.toHexString());
  return playerConnectionCount(ctx, ctx.sender);
}

/** Pick a walkable floor tile from a zone. Used for the cosmetic ghost haunt. */
export function randomWalkableTile(ctx: Ctx, zone: Zone): { x: number; y: number } | undefined {
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y < zone.height; y++) {
    for (let x = 0; x < zone.width; x++) {
      if (isWalkable(zone, x, y)) tiles.push({ x, y });
    }
  }
  if (tiles.length === 0) return undefined;
  return tiles[ctx.random.integerInRange(0, tiles.length - 1)];
}

/** Cap old ghost event rows for a zone; haunts are only useful as fresh inserts. */
export function trimGhostHaunts(ctx: Ctx, zoneId: string): void {
  const rows = [...ctx.db.ghostHaunt.zoneId.filter(zoneId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const excess = rows.length - GHOST_HAUNT_HISTORY_MAX;
  for (let i = 0; i < excess; i++) ctx.db.ghostHaunt.id.delete(rows[i]!.id);
}

/** Arm a single one-shot Hog wander tick, unless one is already pending. The tick
 *  fires once per tile-crossing so a Hog re-bases (and re-checks collision) every tile
 *  (GDD "Hogs"). */
export function armWander(ctx: Ctx): void {
  if (ctx.db.hogWander.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(Math.round(HOG_STEP_INTERVAL_MS)) * 1000n;
  ctx.db.hogWander.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

/**
 * A Hog's heading for the next tile (GDD "Hogs"). A Hog ambling in a direction keeps
 * going so long as that tile is open and a `HOG_TURN_CHANCE` roll doesn't turn it — so
 * it walks in gentle runs rather than jittering every tile. Otherwise (blocked ahead,
 * or it turned, or it was idle) it picks fresh: idle with `HOG_IDLE_CHANCE` so it
 * pauses, else a random walkable cardinal. `bounds` already treats walls, boulders,
 * troggs, and other Hogs as unwalkable, so a picked tile is always clear.
 */
export function pickWanderDir(
  ctx: Ctx,
  bounds: ZoneBounds,
  hog: { dirX: number; dirY: number },
  pos: { x: number; y: number },
  size: number,
): { dirX: number; dirY: number } {
  const options = walkableCardinals(bounds, pos.x, pos.y, size);
  const ahead = options.find((d) => d.dirX === hog.dirX && d.dirY === hog.dirY);
  if (ahead && ctx.random() > HOG_TURN_CHANCE) return ahead;
  if (ctx.random() < HOG_IDLE_CHANCE) return { dirX: 0, dirY: 0 };
  if (options.length === 0) return { dirX: 0, dirY: 0 };
  return options[ctx.random.integerInRange(0, options.length - 1)]!;
}

/** Whether the caller authenticated with a SpacetimeAuth OIDC token (an account, not a guest). */
export function isSpacetimeAuthCaller(ctx: Ctx): boolean {
  return ctx.senderAuth.hasJWT && ctx.senderAuth.jwt?.issuer === SPACETIMEAUTH_ISSUER;
}

/** A valid, free name from the caller's OIDC username claims, or undefined. */
export function claimProviderName(ctx: Ctx): string | undefined {
  const payload = ctx.senderAuth.jwt?.fullPayload ?? {};
  const candidate = payload["preferred_username"] ?? payload["name"];
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return isValidName(trimmed) && !nameTaken(ctx, trimmed, ctx.sender) ? trimmed : undefined;
}

/** Whether another player already holds `name` (case-insensitive). */
export function nameTaken(ctx: Ctx, name: string, self: Ctx["sender"]): boolean {
  const lower = name.toLowerCase();
  for (const other of ctx.db.player.iter()) {
    if (!self.isEqual(other.identity) && other.name.toLowerCase() === lower) return true;
  }
  return false;
}

// Re-export the extracted helper groups so consumers import server-side helpers
// from one place regardless of which file defines them.
export * from "./tiles";
export * from "./inventory";
export * from "./combat";
