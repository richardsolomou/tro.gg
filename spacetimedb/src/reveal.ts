import { Timestamp } from "spacetimedb";
import {
  BOULDER_MAX_HEALTH,
  cellOfSlug,
  DARK_CREATURES,
  densityMultiplierFor,
  HEARTH_REGION_SLUG,
  neighborsOf,
  regionAt,
  regionNameCandidate,
  regionSeeds,
  MAX_DARK_CREATURES_PER_ZONE,
  TREE_MAX_HEALTH,
  type Zone,
} from "../../shared/index";
import type { Ctx } from "./schema";

export { HEARTH_REGION_SLUG };

/** Bootstrap the frontier on first connect: the Hearth interior from the
 *  start, its lattice neighbours exposed as the initial penumbra, and the
 *  Hearth's own boulders and trees seeded. Idempotent — a no-op once the
 *  Hearth's row exists. */
export function seedRevealedHearth(ctx: Ctx, zone: Zone): void {
  if (ctx.db.revealedRegion.slug.find(HEARTH_REGION_SLUG)) return;
  seedRegionPopulation(ctx, zone, HEARTH_REGION_SLUG, 1);
  claimRegionAndExposePenumbra(ctx, zone, HEARTH_REGION_SLUG);
}

/** Every region the tribe has claimed — the rows whose `interior` flag is set.
 *  Penumbra rows (scouted, unclaimed) are excluded: adjacency to this set is
 *  what makes a region penumbra, per the glossary. */
export function currentRevealedRegions(ctx: Ctx): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const row of ctx.db.revealedRegion.iter()) {
    if (row.interior) slugs.add(row.slug);
  }
  return slugs;
}

/**
 * Lock a region's display name (GDD "Generation"): resolve the hash-derived
 * candidate, check it against every name already in `revealed_region` — the
 * one piece of region identity that needs shared, durable state, since
 * uniqueness isn't something one region's own coordinates can guarantee —
 * and reroll (a deterministic secondary hash) until it's unique.
 */
function lockRegionName(ctx: Ctx, slug: string): string {
  const cell = cellOfSlug(slug);
  if (!cell) return slug;
  const taken = new Set<string>();
  for (const row of ctx.db.revealedRegion.iter()) taken.add(row.name);
  for (let attempt = 0; ; attempt++) {
    const candidate = regionNameCandidate(cell.cellX, cell.cellY, attempt);
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Expose a region as penumbra: lock its name, insert its row (interior:
 * false), and seed its population at the density its claim-graph hop-depth
 * earns — deeper regions are tougher to clear, up to the ceiling (GDD
 * "Generation"). No-op if the region already has a row.
 */
export function exposeRegion(ctx: Ctx, zone: Zone, slug: string, hopDepth: number): void {
  if (ctx.db.revealedRegion.slug.find(slug)) return;
  ctx.db.revealedRegion.insert({ slug, name: lockRegionName(ctx, slug), interior: false, revealedAt: ctx.timestamp });
  seedRegionPopulation(ctx, zone, slug, densityMultiplierFor(hopDepth));
}

/** Claim a region: flip its penumbra row interior (the name was locked the
 *  moment a scout could see it, and never changes), or insert the row outright
 *  for the Hearth bootstrap. Returns whether this call actually claimed it. */
export function claimRegion(ctx: Ctx, slug: string): boolean {
  const existing = ctx.db.revealedRegion.slug.find(slug);
  if (existing) {
    if (existing.interior) return false;
    ctx.db.revealedRegion.slug.update({ ...existing, interior: true });
    return true;
  }
  ctx.db.revealedRegion.insert({ slug, name: lockRegionName(ctx, slug), interior: true, revealedAt: ctx.timestamp });
  return true;
}

/**
 * Claim a region and expose whatever regions that newly reveals as the
 * frontier's next penumbra (GDD "Generation") — `neighborsOf` runs the same
 * bounded lattice-neighbour search `regionAt` does, not a lookup table, so
 * the frontier grows into ground no list ever enumerated. No-op if already
 * claimed.
 */
export function claimRegionAndExposePenumbra(ctx: Ctx, zone: Zone, slug: string): void {
  if (!claimRegion(ctx, slug)) return;
  const depth = regionHopDepths(ctx).get(slug) ?? 0;
  for (const neighborSlug of neighborsOf(slug)) exposeRegion(ctx, zone, neighborSlug, depth + 1);
}

/**
 * Each claimed region's hop-distance from the Hearth through the claim graph —
 * BFS over interior rows via lattice adjacency. Orders brazier guttering
 * "deepest first" and prices a fresh penumbra region's seed density: regions
 * vary too much in size/shape for raw tile distance to mean the same thing
 * everywhere, so depth in the claim graph is the fairer "how far out".
 */
export function regionHopDepths(ctx: Ctx): ReadonlyMap<string, number> {
  const interior = currentRevealedRegions(ctx);
  const depths = new Map<string, number>();
  if (!interior.has(HEARTH_REGION_SLUG)) return depths;
  depths.set(HEARTH_REGION_SLUG, 0);
  const queue: string[] = [HEARTH_REGION_SLUG];
  while (queue.length > 0) {
    const slug = queue.shift()!;
    const depth = depths.get(slug)!;
    for (const neighbor of neighborsOf(slug)) {
      if (!interior.has(neighbor) || depths.has(neighbor)) continue;
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
    if (c.health > 0 && regionAt(c.x, c.y).slug === slug) count++;
  }
  return count;
}

/**
 * Seed one region's boulders, trees, and dark creatures from its deterministic
 * per-region seed stream (`regionSeeds`, keyed off the capital coordinates),
 * skipping any entity type the region already has rows of — so a re-exposure
 * after "Reset frontier" never duplicates what's already standing.
 */
export function seedRegionPopulation(ctx: Ctx, zone: Zone, slug: string, multiplier: number, opts: { creatures?: boolean } = {}): void {
  const inRegion = (t: { x: number; y: number }) => regionAt(t.x, t.y).slug === slug;
  const seeds = regionSeeds(slug, multiplier);
  if (![...ctx.db.boulder.zoneId.filter(zone.slug)].some(inRegion)) {
    for (const seed of seeds.boulders) {
      ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: seed.x, y: seed.y, health: BOULDER_MAX_HEALTH, cellId: 0 });
    }
  }
  if (![...ctx.db.tree.zoneId.filter(zone.slug)].some(inRegion)) {
    for (const seed of seeds.trees) {
      ctx.db.tree.insert({ id: 0n, zoneId: zone.slug, x: seed.x, y: seed.y, health: TREE_MAX_HEALTH });
    }
  }
  if (opts.creatures !== false && ![...ctx.db.darkCreature.zoneId.filter(zone.slug)].some(inRegion)) {
    // a deep frontier reveals many regions — the per-zone ceiling still holds
    let population = [...ctx.db.darkCreature.zoneId.filter(zone.slug)].length;
    for (const seed of seeds.darkCreatures) {
      if (population >= MAX_DARK_CREATURES_PER_ZONE) break;
      population++;
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
        nightborn: false,
      strayed: false,
      });
    }
  }
}

/**
 * Re-seed any revealed region stripped of its population — the safety net for
 * debug resets and stale-world purges that deleted region-seeded rows
 * wholesale, since nothing else ever re-seeds an already-revealed region
 * (GDD "Generation"). `seedRegionPopulation` self-guards per entity type, so
 * intact regions are untouched. Nodes heal everywhere; creatures heal only in
 * penumbra — an interior region with no creatures is the tribe's work, not
 * damage (Territory and permanence: killed on lit ground stays dead).
 */
export function healRegionPopulations(ctx: Ctx, zone: Zone): void {
  const depths = regionHopDepths(ctx);
  for (const row of ctx.db.revealedRegion.iter()) {
    seedRegionPopulation(ctx, zone, row.slug, densityMultiplierFor(depths.get(row.slug) ?? 0), { creatures: !row.interior });
  }
}
