import { Timestamp } from "spacetimedb";
import { DARK_CREATURES, regionAt, type Zone } from "../../shared/index";
import type { Ctx } from "./schema";

/** Where the tribe's fire started (GDD "Generation: only as far as the light
 *  reaches") — already lit by the First Fire, so it's interior from the start. */
export const HEARTH_REGION_SLUG = "hearth";

/** Claim the Hearth on first connect, unless already claimed. */
export function seedRevealedHearth(ctx: Ctx): void {
  claimRegion(ctx, HEARTH_REGION_SLUG);
}

/** Every region the tribe has claimed so far — at most 11 rows. */
export function currentRevealedRegions(ctx: Ctx): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const row of ctx.db.revealedRegion.iter()) slugs.add(row.slug);
  return slugs;
}

/** Claim a region (an ignition succeeded there, or a debug reveal), unless
 *  already interior. Returns whether this call actually claimed it. */
export function claimRegion(ctx: Ctx, slug: string): boolean {
  if (ctx.db.revealedRegion.slug.find(slug)) return false;
  ctx.db.revealedRegion.insert({ slug, revealedAt: ctx.timestamp });
  return true;
}

/**
 * Seed one region's dark creatures and ember-hearts from the zone's
 * committed registry, unless it already has population there. Called the
 * moment a region becomes penumbra — freshly adjacent to a claimed region —
 * so a scout can find what's inside before anyone claims it themselves.
 */
export function seedRegionPopulation(ctx: Ctx, zone: Zone, slug: string): void {
  const inRegion = (t: { x: number; y: number }) => regionAt(t.x, t.y)?.slug === slug;
  if (![...ctx.db.darkCreature.zoneId.filter(zone.slug)].some(inRegion)) {
    for (const seed of zone.darkCreatures.filter(inRegion)) {
      ctx.db.darkCreature.insert({
        id: 0n,
        zoneId: zone.slug,
        x: seed.x,
        y: seed.y,
        dirX: 0,
        dirY: 0,
        movedAt: Timestamp.UNIX_EPOCH,
        species: seed.species,
        health: DARK_CREATURES[seed.species].maxHealth,
        lastDamagedAt: Timestamp.UNIX_EPOCH,
        aggroTargetId: "",
      });
    }
  }
  if (![...ctx.db.emberHeart.zoneId.filter(zone.slug)].some(inRegion)) {
    for (const seed of zone.emberHearts.filter(inRegion)) {
      ctx.db.emberHeart.insert({ id: 0n, zoneId: zone.slug, x: seed.x, y: seed.y });
    }
  }
}
