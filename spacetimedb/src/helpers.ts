import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  GHOST_HAUNT_HISTORY_MAX,
  WANDER_IDLE_CHANCE,
  HEALTH_REGEN_TICK_MS,
  BRAZIER_UPKEEP_TICK_MS,
  AFK_WANDER_TICK_MS,
  NODE_RESPAWN_MS,
  isValidName,
  isWalkable,
  BOULDER_MAX_HEALTH,
  TREE_MAX_HEALTH,
  SPACETIMEAUTH_ISSUER,
  getZone,
  walkableSteps,
  type Zone,
  type ZoneBounds,
} from "../../shared/index";
import { countRows, darkCreatureDef } from "./tiles";
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
 * walls, and poisoning collision. Detect any seedable row on unwalkable ground
 * and wipe the zone's boulders, trees, dark creatures, and ground items; the
 * idempotent seeders right after then re-seed from the current map.
 */
export function healStaleWorld(ctx: Ctx, zone: Zone): void {
  const boulders = [...ctx.db.boulder.zoneId.filter(zone.slug)];
  const trees = [...ctx.db.tree.zoneId.filter(zone.slug)];
  const items = [...ctx.db.groundItem.zoneId.filter(zone.slug)];
  const creatures = [...ctx.db.darkCreature.zoneId.filter(zone.slug)];
  const stale =
    boulders.some((b) => !isWalkable(zone, b.x, b.y)) ||
    trees.some((tr) => !isWalkable(zone, tr.x, tr.y)) ||
    items.some((g) => !isWalkable(zone, g.x, g.y)) ||
    creatures.some((c) => !isWalkable(zone, Math.round(c.x), Math.round(c.y)));
  if (!stale) return;
  for (const b of boulders) ctx.db.boulder.id.delete(b.id);
  for (const tr of trees) ctx.db.tree.id.delete(tr.id);
  for (const g of items) ctx.db.groundItem.id.delete(g.id);
  for (const c of creatures) ctx.db.darkCreature.id.delete(c.id);
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

/** Seed a zone's dark creatures from the registry, unless it already has some
 *  (GDD "Dark creatures"). */
export function seedDarkCreatures(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.darkCreature.zoneId.filter(zone.slug)].length > 0) return;
  for (const seed of zone.darkCreatures) {
    ctx.db.darkCreature.insert({
      id: 0n,
      zoneId: zone.slug,
      x: seed.x,
      y: seed.y,
      dirX: 0,
      dirY: 0,
      movedAt: Timestamp.UNIX_EPOCH,
      species: seed.species,
      health: darkCreatureDef(seed.species).maxHealth,
      lastDamagedAt: Timestamp.UNIX_EPOCH,
      aggroTargetId: "",
    });
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

/** Whether any player is currently online — scheduled sweeps only run while
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

/** Pick a walkable floor tile near an origin — the world has no bounded grid
 *  to enumerate, so sample a radius instead. Used for the cosmetic ghost haunt. */
export function randomWalkableTile(ctx: Ctx, zone: Zone, origin: { x: number; y: number }, radius = 12): { x: number; y: number } | undefined {
  for (let attempt = 0; attempt < 80; attempt++) {
    const x = Math.round(origin.x) + ctx.random.integerInRange(-radius, radius);
    const y = Math.round(origin.y) + ctx.random.integerInRange(-radius, radius);
    if (isWalkable(zone, x, y)) return { x, y };
  }
  return undefined;
}

/** Cap old ghost event rows for a zone; haunts are only useful as fresh inserts. */
export function trimGhostHaunts(ctx: Ctx, zoneId: string): void {
  const rows = [...ctx.db.ghostHaunt.zoneId.filter(zoneId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const excess = rows.length - GHOST_HAUNT_HISTORY_MAX;
  for (let i = 0; i < excess; i++) ctx.db.ghostHaunt.id.delete(rows[i]!.id);
}

/**
 * A fresh wander heading, picked when a run ends — blocked ahead, a turn roll,
 * or waking from idle. Idle with `WANDER_IDLE_CHANCE` so a wanderer pauses, else
 * a random open step from all 8 directions (`walkableSteps` keeps diagonals from
 * squeezing wall corners). `bounds` already treats walls, boulders, trees, and
 * troggs as unwalkable.
 */
export function pickWanderDir(
  ctx: Ctx,
  bounds: ZoneBounds,
  pos: { x: number; y: number },
  size: number,
): { dirX: number; dirY: number } {
  if (ctx.random() < WANDER_IDLE_CHANCE) return { dirX: 0, dirY: 0 };
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

/** Arm the brazier upkeep sweep, unless one is already pending (GDD "The fire
 *  and the dark" → Territory and permanence). */
export function armBrazierUpkeep(ctx: Ctx): void {
  if (ctx.db.brazierUpkeepTimer.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(BRAZIER_UPKEEP_TICK_MS) * 1000n;
  ctx.db.brazierUpkeepTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

/** Arm a one-shot respawn for a just-broken node (GDD "Territory claiming":
 *  a broken node returns in place after `NODE_RESPAWN_MS`), so settled ground
 *  never runs dry however long it's farmed. */
export function scheduleNodeRespawn(ctx: Ctx, zoneId: string, kind: "boulder" | "tree", x: number, y: number): void {
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(NODE_RESPAWN_MS) * 1000n;
  ctx.db.nodeRespawn.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at), zoneId, kind, x, y });
}

/** Arm the AFK-trogg wander sweep, unless one is already pending (GDD "The
 *  fire and the dark" → Presence). */
export function armAfkWander(ctx: Ctx): void {
  if (ctx.db.afkWanderTimer.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(AFK_WANDER_TICK_MS) * 1000n;
  ctx.db.afkWanderTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
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
export * from "./brazier";
export * from "./presence";
export * from "./reveal";
