import { ScheduleAt } from "spacetimedb";
import {
  GHOST_HAUNT_HISTORY_MAX,
  HEALTH_REGEN_TICK_MS,
  isValidName,
  isWalkable,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  SPACETIMEAUTH_ISSUER,
  getZone,
  type Zone,
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
 * walls, and poisoning collision (a creature projected from inside rock makes
 * the client and server disagree about blocked tiles). Detect any seedable row
 * on unwalkable ground and wipe the zone's boulders, trees, and ground items; the
 * idempotent seeders right after then re-seed from the current map.
 */
export function healStaleWorld(ctx: Ctx, zone: Zone): void {
  const boulders = [...ctx.db.boulder.zoneId.filter(zone.slug)];
  const trees = [...ctx.db.tree.zoneId.filter(zone.slug)];
  const items = [...ctx.db.groundItem.zoneId.filter(zone.slug)];
  const stale =
    boulders.some((b) => !isWalkable(zone, b.x, b.y)) ||
    trees.some((tr) => !isWalkable(zone, tr.x, tr.y)) ||
    items.some((g) => !isWalkable(zone, g.x, g.y));
  if (!stale) return;
  for (const b of boulders) ctx.db.boulder.id.delete(b.id);
  for (const tr of trees) ctx.db.tree.id.delete(tr.id);
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

/** Whether any player is currently online — scheduled sweeps only do work while
 *  someone is watching (invariant 1: an empty zone does no work). */
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
export * from "./stockpile";
export * from "./braziers";
export * from "./darkcreatures";
export * from "./embertroggs";
export * from "./ignition";
