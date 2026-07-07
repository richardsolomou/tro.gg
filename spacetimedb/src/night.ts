import {
  DAY_CYCLE_MS,
  footprintWalkable,
  getZone,
  MAX_DARK_CREATURES_PER_ZONE,
  NIGHT_COHORT_FRACTION,
  NIGHT_SPAWN_MIN_PLAYER_DIST,
  regionAt,
  regionSeeds,
  STARTING_ZONE_SLUG,
  tileKey,
  zoneBounds,
  type Coord,
  type Zone,
  type ZoneBounds,
} from "../../shared/index";
import { isSanctuaryTile } from "./brazier";
import { darkCreatureDef, obstacleTiles, settle } from "./tiles";
import type { Ctx } from "./schema";

/**
 * The night tide (GDD "The fire and the dark" → Night). At dusk every lit
 * region gains a cohort of dark creatures — placed along the region's rim,
 * away from its brazier, never near an active trogg — and at dawn the
 * survivors despawn: no corpse, no loot, the tide just goes out. Visitors,
 * not residents: a kill drops loot but depletes nothing, and a fresh cohort
 * walks in next dusk. One seeding per day-cycle (the private `night_tide`
 * row remembers which cycle last seeded), so a night is one tide, not a
 * per-tick spawner.
 */
export function tideNight(ctx: Ctx, now: Ctx["timestamp"], night: boolean): void {
  if (!night) {
    for (const c of [...ctx.db.darkCreature.iter()]) if (c.nightborn) ctx.db.darkCreature.id.delete(c.id);
    return;
  }
  const cycle = BigInt(Math.floor(Number(now.microsSinceUnixEpoch / 1000n) / DAY_CYCLE_MS));
  const state = ctx.db.nightTide.id.find(0);
  if (state && state.cycle === cycle) return;
  if (state) ctx.db.nightTide.id.update({ ...state, cycle });
  else ctx.db.nightTide.insert({ id: 0, cycle });

  const zone = getZone(STARTING_ZONE_SLUG);
  if (!zone) return;
  const actives: Coord[] = [];
  for (const p of ctx.db.player.zoneId.filter(zone.slug)) {
    if (p.online && !p.dead) actives.push(settle(ctx, p, now));
  }
  const statics = obstacleTiles(ctx, zone.slug);
  const bounds = zoneBounds(zone, (x, y) => statics.has(tileKey(x, y)));
  let population = [...ctx.db.darkCreature.zoneId.filter(zone.slug)].length;

  for (const b of ctx.db.brazier.zoneId.filter(zone.slug)) {
    if (!b.lit) continue;
    const slug = regionAt(b.x, b.y)?.slug;
    if (!slug) continue;
    const seeds = regionSeeds(slug).darkCreatures;
    if (seeds.length === 0) continue;
    const cohort = Math.max(1, Math.round(seeds.length * NIGHT_COHORT_FRACTION));
    for (const seed of seeds.slice(0, cohort)) {
      if (population >= MAX_DARK_CREATURES_PER_ZONE) return;
      const at = nightEntryTile(ctx, zone, slug, seed, b, bounds);
      if (!at) continue;
      if (actives.some((a) => Math.hypot(a.x - at.x, a.y - at.y) < NIGHT_SPAWN_MIN_PLAYER_DIST)) continue;
      ctx.db.darkCreature.insert({
        id: 0n,
        zoneId: zone.slug,
        x: at.x,
        y: at.y,
        dirX: 0,
        dirY: 0,
        movedAt: now,
        species: seed.species,
        health: darkCreatureDef(seed.species).maxHealth,
        lastDamagedAt: now,
        aggroTargetId: "",
        nightborn: true,
      });
      population++;
    }
  }
}

/** Walk a resident seed spot outward, directly away from the region's
 *  brazier, to the last walkable in-region tile — the rim the tide seeps in
 *  from — falling back to the seed spot itself when the rim is all rock.
 *  Never inside the sanctuary ring. */
function nightEntryTile(ctx: Ctx, zone: Zone, slug: string, seed: Coord, brazier: Coord, bounds: ZoneBounds): Coord | undefined {
  const dx = seed.x - brazier.x;
  const dy = seed.y - brazier.y;
  const len = Math.hypot(dx, dy) || 1;
  let best: Coord | undefined;
  for (let i = 0; i < 80; i++) {
    const x = Math.round(seed.x + (dx / len) * i);
    const y = Math.round(seed.y + (dy / len) * i);
    if (regionAt(x, y)?.slug !== slug) break;
    if (footprintWalkable(bounds, x, y, 1) && !isSanctuaryTile(ctx, zone.slug, x, y)) best = { x, y };
  }
  if (!best && footprintWalkable(bounds, seed.x, seed.y, 1) && !isSanctuaryTile(ctx, zone.slug, seed.x, seed.y)) {
    best = { x: seed.x, y: seed.y };
  }
  return best;
}
