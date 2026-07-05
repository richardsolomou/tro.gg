import {
  STARTING_ZONE_SLUG,
  WORLD_GENERATOR_VERSION,
  getZone,
  penumbraRing,
  worldRingSeed,
} from "../../shared/index";
import type { Ctx } from "./schema";
import { seedDarkCreatureRing } from "./dark-creatures";

export function ensureWorldRings(ctx: Ctx): number[] {
  const origin = getZone(STARTING_ZONE_SLUG)?.spawn;
  if (!origin) return [];
  const target = penumbraRing(origin, ctx.db.brazier.zoneId.filter(STARTING_ZONE_SLUG), STARTING_ZONE_SLUG);
  const inserted: number[] = [];
  for (let ring = 0; ring <= target; ring++) {
    if (ctx.db.worldRing.ring.find(ring)) continue;
    ctx.db.worldRing.insert({
      ring,
      seed: worldRingSeed(ring),
      generatorVersion: WORLD_GENERATOR_VERSION,
      generatedAt: ctx.timestamp,
    });
    seedDarkCreatureRing(ctx, STARTING_ZONE_SLUG, ring);
    inserted.push(ring);
  }
  return inserted;
}
