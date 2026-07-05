import { ScheduleAt } from "spacetimedb";
import { BRAZIER_UPKEEP_TICK_MS, FIRST_FIRE_RADIUS, type Zone } from "../../shared/index";
import type { Ctx } from "./schema";
import { spawnAt } from "./tiles";

/**
 * Seed a zone's First Fire — the one eternal hearth, at the zone's spawn point
 * (GDD "The fire and the dark" → Territory and permanence) — unless the zone
 * already has one. Idempotent, like the boulder/tree seeders.
 */
export function seedFirstFire(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.brazier.zoneId.filter(zone.slug)].some((b) => b.isEternal)) return;
  const at = zone.spawn ?? { x: 0, y: 0 };
  ctx.db.brazier.insert({ id: 0n, zoneId: zone.slug, x: at.x, y: at.y, radius: FIRST_FIRE_RADIUS, lit: true, isEternal: true });
}

/** Whether (x, y) sits inside any lit hearth or brazier's radius in the zone —
 *  the ground dark creatures cannot cross into (GDD "Dark creatures", "The fire
 *  and the dark" → Territory and permanence). */
export function isLit(ctx: Ctx, zoneId: string, x: number, y: number): boolean {
  for (const b of ctx.db.brazier.zoneId.filter(zoneId)) {
    if (b.lit && Math.hypot(x - b.x, y - b.y) <= b.radius) return true;
  }
  return false;
}

/**
 * Whether (x, y) is "safe interior ground" — lit, and not inside the single
 * lit non-eternal brazier furthest from the First Fire (the current
 * frontline, reserved as bright-only risk). With only the First Fire lit, its
 * whole radius counts as interior. Ember troggs work interior ground only
 * (GDD "The fire and the dark" → Presence).
 */
export function isInteriorGround(ctx: Ctx, zoneId: string, x: number, y: number): boolean {
  if (!isLit(ctx, zoneId, x, y)) return false;
  const frontier = guttermostLitBrazier(
    ctx,
    [...ctx.db.brazier.zoneId.filter(zoneId)].filter((b) => b.lit && !b.isEternal),
  );
  if (!frontier) return true;
  return Math.hypot(x - frontier.x, y - frontier.y) > frontier.radius;
}

/** The First Fire of a zone, if seeded. */
export function firstFireOf(ctx: Ctx, zoneId: string): { x: number; y: number } | undefined {
  for (const b of ctx.db.brazier.zoneId.filter(zoneId)) if (b.isEternal) return { x: b.x, y: b.y };
  return undefined;
}

/** The lit, non-eternal brazier furthest from its zone's First Fire — the next
 *  one to gutter when upkeep can't be paid (outermost-first recession). */
export function guttermostLitBrazier<T extends { zoneId: string; x: number; y: number }>(ctx: Ctx, lit: readonly T[]): T | undefined {
  let farthest: T | undefined;
  let farthestDist = -1;
  for (const b of lit) {
    const origin = firstFireOf(ctx, b.zoneId);
    const dist = origin ? Math.hypot(b.x - origin.x, b.y - origin.y) : 0;
    if (dist > farthestDist) {
      farthestDist = dist;
      farthest = b;
    }
  }
  return farthest;
}

/**
 * Where a trogg disconnecting at (x, y) ends up: unlit ground recalls it to the
 * zone's hearth before it can go ember (GDD "The fire and the dark" → Presence
 * — "Recall on disconnect from unclaimed ground"), the same rescue-style
 * treatment `nearestSafeTile` gives a trogg stranded by a world regen. Lit
 * ground is left untouched — ember troggs only ever exist on safe ground.
 */
export function recallToHearth(ctx: Ctx, zone: Zone, x: number, y: number): { x: number; y: number } {
  if (isLit(ctx, zone.slug, x, y)) return { x, y };
  return spawnAt(zone);
}

/** Arm the brazier upkeep sweep, unless one is already pending. */
export function armBrazierUpkeep(ctx: Ctx): void {
  if (ctx.db.brazierUpkeep.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(BRAZIER_UPKEEP_TICK_MS) * 1000n;
  ctx.db.brazierUpkeep.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

/** Seed a zone's frontier row — the already-committed core counts as ring 1,
 *  already revealed (GDD "The fire and the dark" → Generation) — unless it
 *  already has one. Idempotent, like the boulder/tree/First-Fire seeders. */
export function seedFrontier(ctx: Ctx, zone: Zone): void {
  if (ctx.db.frontier.zoneId.find(zone.slug)) return;
  ctx.db.frontier.insert({ zoneId: zone.slug, ringsRevealed: 1 });
}
