import { FIRST_FIRE_LIT_RADIUS, type Zone } from "../../shared/index";
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

/** Whether (x, y) sits inside any lit brazier's radius in a zone — the
 *  "cannot enter a lit tile" boundary dark creatures can't cross, and the
 *  ground an ember trogg is confined to. */
export function isLitTile(ctx: Ctx, zoneId: string, x: number, y: number): boolean {
  for (const b of ctx.db.brazier.zoneId.filter(zoneId)) {
    if (b.lit && Math.hypot(x - b.x, y - b.y) <= b.radius) return true;
  }
  return false;
}

/** The nearest lit brazier in a zone (Euclidean, centre to centre), or
 *  undefined if the zone has none lit — used to recall a disconnecting trogg
 *  to safety and to settle a dormant one. */
export function nearestLitBrazier(ctx: Ctx, zoneId: string, x: number, y: number) {
  const rows = [...ctx.db.brazier.zoneId.filter(zoneId)].filter((b) => b.lit);
  let best: { row: (typeof rows)[number]; dist: number } | undefined;
  for (const row of rows) {
    const dist = Math.hypot(x - row.x, y - row.y);
    if (!best || dist < best.dist) best = { row, dist };
  }
  return best?.row;
}
