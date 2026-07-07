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
import { isLitTile, isSanctuaryTile } from "./brazier";
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
export function tideNight(ctx: Ctx, now: Ctx["timestamp"], night: boolean, revealed: (zone: Zone, x: number, y: number) => boolean): void {
  if (!night) {
    for (const c of [...ctx.db.darkCreature.iter()]) {
      if (c.nightborn) {
        ctx.db.darkCreature.id.delete(c.id);
        continue;
      }
      // A resident the night let stray onto claimed ground (or one stranded
      // by an older build) recedes with the tide: walk it to the nearest
      // unlit revealed tile, where it belongs by day.
      if (c.health <= 0) continue; // corpses reap on their own clock
      const zone = getZone(c.zoneId);
      if (!zone) continue;
      const cx = Math.round(c.x);
      const cy = Math.round(c.y);
      if (!isLitTile(ctx, c.zoneId, cx, cy)) continue;
      const out = nearestUnlitTile(ctx, zone, cx, cy, revealed);
      if (out) ctx.db.darkCreature.id.update({ ...c, x: out.x, y: out.y, dirX: 0, dirY: 0, movedAt: now, aggroTargetId: "" });
      else ctx.db.darkCreature.id.delete(c.id); // nowhere in reach to recede to
    }
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

/** The nearest revealed, unlit, walkable tile — where a creature stranded on
 *  claimed ground recedes to at dawn. Rings outward to a bounded radius. */
function nearestUnlitTile(ctx: Ctx, zone: Zone, cx: number, cy: number, revealed: (zone: Zone, x: number, y: number) => boolean): Coord | undefined {
  const statics = obstacleTiles(ctx, zone.slug);
  const bounds = zoneBounds(zone, (x, y) => statics.has(tileKey(x, y)));
  for (let r = 1; r <= 60; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (const dy of dx === -r || dx === r ? Array.from({ length: 2 * r + 1 }, (_, i) => i - r) : [-r, r]) {
        const x = cx + dx;
        const y = cy + dy;
        if (isLitTile(ctx, zone.slug, x, y)) continue;
        if (!revealed(zone, x, y)) continue;
        if (!footprintWalkable(bounds, x, y, 1)) continue;
        return { x, y };
      }
    }
  }
  return undefined;
}
