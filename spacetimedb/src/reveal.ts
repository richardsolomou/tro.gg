import { Timestamp } from "spacetimedb";
import { DARK_CREATURES, neighborsOf, regionAt, type Zone } from "../../shared/index";
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

/** Claim a region (a group cleared it and set down a brazier, or a debug
 *  reveal), unless already interior. Returns whether this call actually
 *  claimed it. */
export function claimRegion(ctx: Ctx, slug: string): boolean {
  if (ctx.db.revealedRegion.slug.find(slug)) return false;
  ctx.db.revealedRegion.insert({ slug, revealedAt: ctx.timestamp });
  return true;
}

/**
 * Claim a region and seed whatever regions that newly exposes as penumbra
 * (GDD "Generation: only as far as the light reaches") — reusing the same
 * committed per-region seed lists worldgen already drew, so a scout can find
 * what's inside before anyone claims it themselves. No-op if already claimed.
 */
export function claimRegionAndExposePenumbra(ctx: Ctx, zone: Zone, slug: string): void {
  if (!claimRegion(ctx, slug)) return;
  for (const neighborSlug of neighborsOf(slug)) {
    if (!ctx.db.revealedRegion.slug.find(neighborSlug)) seedRegionPopulation(ctx, zone, neighborSlug);
  }
}

/**
 * Each region's hop-distance from the Hearth via the committed adjacency
 * graph — used to order brazier guttering "outermost first" (GDD "The fire
 * and the dark" → Territory and permanence). Regions vary too much in
 * size/shape for raw tile distance to mean the same thing everywhere, so
 * depth in the claim graph is the fairer "how far out" measure.
 */
export function regionHopDepths(): ReadonlyMap<string, number> {
  const depths = new Map<string, number>([[HEARTH_REGION_SLUG, 0]]);
  const queue: string[] = [HEARTH_REGION_SLUG];
  while (queue.length > 0) {
    const slug = queue.shift()!;
    const depth = depths.get(slug)!;
    for (const neighbor of neighborsOf(slug)) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, depth + 1);
      queue.push(neighbor);
    }
  }
  return depths;
}

/** Every living dark creature currently in a region (GDD "Dark creatures" /
 *  "Territory and permanence") — the obstacle a group must clear to zero
 *  before a brazier can go down there. */
export function livingDarkCreaturesInRegion(ctx: Ctx, zoneId: string, slug: string): number {
  let count = 0;
  for (const c of ctx.db.darkCreature.zoneId.filter(zoneId)) {
    if (c.health > 0 && regionAt(c.x, c.y)?.slug === slug) count++;
  }
  return count;
}

/**
 * Seed one region's dark creatures from the zone's committed registry,
 * unless it already has population there. Called the moment a region
 * becomes penumbra — freshly adjacent to a claimed region — so a scout can
 * find what's inside before anyone claims it themselves.
 */
export function seedRegionPopulation(ctx: Ctx, zone: Zone, slug: string): void {
  const inRegion = (t: { x: number; y: number }) => regionAt(t.x, t.y)?.slug === slug;
  if ([...ctx.db.darkCreature.zoneId.filter(zone.slug)].some(inRegion)) return;
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
