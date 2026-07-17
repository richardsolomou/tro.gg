import { dayPhaseAt, FIRST_FIRE_LIT_RADIUS, regionAt, STARTING_ZONE_SLUG, type Zone } from "../../shared/index";
import type { Ctx } from "./schema";

/** Seed the First Fire — the one eternal brazier — at a zone's spawn point,
 *  unless the zone already has one (GDD "The fire and the dark" → Territory
 *  and permanence). */
export function seedFirstFire(ctx: Ctx, zone: Zone): void {
  const hasFirstFire = [...ctx.db.brazier.zoneId.filter(zone.slug)].some((b) => b.isEternal);
  if (hasFirstFire) return;
  const at = zone.spawn ?? { x: Math.floor(zone.width / 2), y: Math.floor(zone.height / 2) };
  ctx.db.brazier.insert({ id: 0n, zoneId: zone.slug, x: at.x, y: at.y, radius: FIRST_FIRE_LIT_RADIUS, lit: true, isEternal: true });
}

/**
 * Whether (x, y) sits in ground the tribe currently holds against the dark
 * (GDD "Territory and permanence") — the "cannot enter a lit tile" boundary
 * dark creatures can't cross, and the ground an AFK trogg is confined to.
 * In the world zone this is region-wide: a whole region counts as lit the
 * moment any brazier inside it is lit, not just a radius around that
 * brazier — a region holds at most one non-eternal row, always placed
 * alongside claiming it (`claimRegionAndExposePenumbra`), so "in penumbra"
 * and "has no brazier yet" are the same fact. Other zones (birth caves have
 * no regions) fall back to "any brazier lit in the zone," moot in practice
 * since none are ever seeded there.
 */
export function isLitTile(ctx: Ctx, zoneId: string, x: number, y: number): boolean {
  if (zoneId !== STARTING_ZONE_SLUG) {
    for (const b of ctx.db.brazier.zoneId.filter(zoneId)) if (b.lit) return true;
    return false;
  }
  const slug = regionAt(x, y)?.slug;
  if (!slug) return false;
  for (const b of ctx.db.brazier.zoneId.filter(zoneId)) {
    if (b.lit && regionAt(b.x, b.y)?.slug === slug) return true;
  }
  return false;
}

/** Whether (x, y) sits inside a lit brazier's sanctuary ring — the only
 *  ground the dark cannot enter at night (GDD "The fire and the dark" →
 *  Night). Euclidean, centre to centre; the ring is the brazier's `radius`. */
export function isSanctuaryTile(ctx: Ctx, zoneId: string, x: number, y: number): boolean {
  for (const b of ctx.db.brazier.zoneId.filter(zoneId)) {
    if (b.lit && Math.hypot(b.x - x, b.y - y) <= b.radius) return true;
  }
  return false;
}

/** The ground the dark cannot enter right now (GDD "Bound by the light"):
 *  whole lit regions by day, only the sanctuary rings at night. */
export function isSafeTile(ctx: Ctx, zoneId: string, x: number, y: number, night: boolean): boolean {
  return night ? isSanctuaryTile(ctx, zoneId, x, y) : isLitTile(ctx, zoneId, x, y);
}

/** The shared day phase, server-side: the same wall-clock derivation every
 *  client renders the sky from, honouring the debug sky lock so a pinned sky
 *  pins the night mechanics with it (GDD "Zones"; "Night"). */
export function worldDayPhase(ctx: Ctx): number {
  for (const ws of ctx.db.worldState.iter()) {
    if (ws.skyLocked) return Math.min(1, Math.max(0, ws.skyPhase));
  }
  return dayPhaseAt(Number(ctx.timestamp.microsSinceUnixEpoch / 1000n));
}

/** The nearest lit brazier in a zone (Euclidean, centre to centre), or
 *  undefined if the zone has none lit — used to recall a disconnecting trogg
 *  to safety and to settle a spent one. */
export function nearestLitBrazier(ctx: Ctx, zoneId: string, x: number, y: number) {
  const rows = [...ctx.db.brazier.zoneId.filter(zoneId)].filter((b) => b.lit);
  let best: { row: (typeof rows)[number]; dist: number } | undefined;
  for (const row of rows) {
    const dist = Math.hypot(x - row.x, y - row.y);
    if (!best || dist < best.dist) best = { row, dist };
  }
  return best?.row;
}
