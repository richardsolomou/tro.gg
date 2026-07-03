import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  GHOST_HAUNT_HISTORY_MAX,
  HOG_IDLE_CHANCE,
  HOG_STEP_INTERVAL_MS,
  HOG_TURN_CHANCE,
  HEALTH_REGEN_TICK_MS,
  isValidName,
  isWalkable,
  HOG_MAX_HEALTH,
  hogMaxHealth,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  SPACETIMEAUTH_ISSUER,
  getZone,
  tileKey,
  walkableSteps,
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

/** Seed a zone's boulders from the registry, unless it already has some.
 *  Warren rubble is not the registry's — only world boulders count. */
export function seedBoulders(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.boulder.zoneId.filter(zone.slug)].some((b) => !b.cellId)) return;
  for (const b of zone.boulders) {
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: b.x, y: b.y, health: BOULDER_MAX_HEALTH, cellId: 0 });
  }
}

/** Seed a zone's trees from the registry, unless it already has some. */
export function seedTrees(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.tree.zoneId.filter(zone.slug)].length > 0) return;
  for (const tr of zone.trees) {
    ctx.db.tree.insert({ id: 0n, zoneId: zone.slug, x: tr.x, y: tr.y, health: TREE_MAX_HEALTH });
  }
}

/** Seed a zone's Hogs from the registry, unless it already has some — the common
 *  roamers (style "" → client-derived skin) and the rare 2×2 showpieces (explicit
 *  style, so `hogSize` makes them big). */
export function seedHogs(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.hog.zoneId.filter(zone.slug)].length > 0) return;
  for (const h of zone.hogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: "", health: HOG_MAX_HEALTH, lastDamagedAt: Timestamp.UNIX_EPOCH });
  }
  for (const h of zone.bigHogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: h.style, health: hogMaxHealth(h.style), lastDamagedAt: Timestamp.UNIX_EPOCH });
  }
}

/** Seed a zone's starter pickup items from the registry, unless it already has some. */
export function seedGroundItems(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.groundItem.zoneId.filter(zone.slug)].length > 0) return;
  for (const item of zone.items) {
    ctx.db.groundItem.insert({ id: 0n, zoneId: zone.slug, item: item.item, x: item.x, y: item.y, qty: 1 });
  }
}

// ── the instanced birth cave (GDD "Onboarding: the Warren") ─────────────────────
// Every newborn gets a private copy of the `birthcave` template: its rubble and
// pickaxe are ordinary rows scoped by the player's own `birth:<hex>` zone id,
// which nobody else ever subscribes to — single-player by construction, so no
// occupancy tracking, no reclaim, and nothing another player could steal.

/** Seed one newborn's private cave: rubble plugs the cell corridor, a pickaxe
 *  waits beside the spawn. Idempotent per zone id. */
export function seedBirthInstance(ctx: Ctx, zoneId: string): void {
  const zone = getZone(zoneId);
  const cell = zone?.cells[0];
  if (!zone || !cell) return;
  if ([...ctx.db.boulder.zoneId.filter(zoneId)].length > 0) return;
  for (const t of cell.corridor) {
    ctx.db.boulder.insert({ id: 0n, zoneId, x: t.x, y: t.y, health: BOULDER_MAX_HEALTH, cellId: 1 });
  }
  ctx.db.groundItem.insert({ id: 0n, zoneId, item: "pickaxe", x: cell.pickaxe.x, y: cell.pickaxe.y, qty: 1 });
}

/** Erase a departed newborn's private cave rows — the instance simply ceases. */
export function wipeBirthInstance(ctx: Ctx, zoneId: string): void {
  for (const b of [...ctx.db.boulder.zoneId.filter(zoneId)]) ctx.db.boulder.id.delete(b.id);
  for (const g of [...ctx.db.groundItem.zoneId.filter(zoneId)]) ctx.db.groundItem.id.delete(g.id);
  for (const h of [...ctx.db.hog.zoneId.filter(zoneId)]) ctx.db.hog.id.delete(h.id);
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
 * A fresh wander heading (GDD "Hogs"), picked when a run ends — blocked ahead,
 * a turn roll, or waking from idle. Idle with `HOG_IDLE_CHANCE` so Hogs pause,
 * else a random open step from all 8 directions (`walkableSteps` keeps
 * diagonals from squeezing wall corners). `bounds` already treats walls,
 * boulders, trees, troggs, and other Hogs as unwalkable.
 */
export function pickWanderDir(
  ctx: Ctx,
  bounds: ZoneBounds,
  pos: { x: number; y: number },
  size: number,
): { dirX: number; dirY: number } {
  if (ctx.random() < HOG_IDLE_CHANCE) return { dirX: 0, dirY: 0 };
  const options = walkableSteps(bounds, pos.x, pos.y, size);
  if (options.length === 0) return { dirX: 0, dirY: 0 };
  return options[ctx.random.integerInRange(0, options.length - 1)]!;
}

/** Arm the out-of-combat regen sweep, unless one is already pending (GDD "Combat"). */
export function armRegen(ctx: Ctx): void {
  if (ctx.db.creatureRegen.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(HEALTH_REGEN_TICK_MS) * 1000n;
  ctx.db.creatureRegen.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
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
