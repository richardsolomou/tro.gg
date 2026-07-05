import {
  bankedKindlingCharge,
  elapsedMs,
  EMBER_GATHER_INTERVAL_MS,
  footprintWalkable,
  getZone,
  kindlingChargeNow,
  projectMotion,
  STOCKPILE_ITEM_IDS,
  tileKey,
  type Stamp,
  zoneBounds,
} from "../../shared/index";
import { troggBlockers, addPlayerTiles, pickWanderDir } from "./tiles";
import { isInteriorGround } from "./braziers";
import { depositStockpile } from "./stockpile";
import type { Ctx } from "./schema";

/**
 * Move and feed every ember trogg (GDD "The fire and the dark" → Presence): a
 * disconnected trogg with kindling charge left keeps working safe interior
 * ground on instinct — the same scheduled-wander pattern that once drove the
 * retired Hogs, confined to lit ground the frontline's outermost brazier
 * doesn't itself claim as risk. No pathing to a specific node: an ember trogg
 * deposits into the stockpile at a fixed cadence (`EMBER_GATHER_INTERVAL_MS`,
 * sized to `EMBER_EFFICIENCY_FRACTION` of a bright trogg's rate) wherever it
 * happens to be ambling, and earns no XP — instinct isn't judgment.
 */
export function wanderEmberTroggs(ctx: Ctx, now: Stamp): void {
  const blockersByZone = new Map<string, Set<string>>();
  const blockersFor = (zoneId: string): Set<string> => {
    let set = blockersByZone.get(zoneId);
    if (!set) {
      set = troggBlockers(ctx, zoneId);
      addPlayerTiles(ctx, zoneId, now, set);
      blockersByZone.set(zoneId, set);
    }
    return set;
  };

  for (const p of ctx.db.player.iter()) {
    if (p.online || p.dead) continue;
    if (kindlingChargeNow(p, now) <= 0) continue; // dormant: settled, not working
    const zone = getZone(p.zoneId);
    if (!zone) continue;

    const blockers = blockersFor(p.zoneId);
    const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)) || !isInteriorGround(ctx, p.zoneId, x, y));
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);

    const moving = p.dirX !== 0 || p.dirY !== 0;
    const stepX = Math.sign(p.dirX);
    const stepY = Math.sign(p.dirY);
    const dir = moving && footprintWalkable(bounds, x + stepX, y + stepY) ? { dirX: stepX, dirY: stepY } : pickWanderDir(ctx, bounds, { x, y });

    const gatherDue = elapsedMs(p.lastEmberGatherAt, now) >= EMBER_GATHER_INTERVAL_MS;
    if (gatherDue) {
      const item = STOCKPILE_ITEM_IDS[ctx.random.integerInRange(0, STOCKPILE_ITEM_IDS.length - 1)]!;
      depositStockpile(ctx, item, 1);
    }

    const unchanged = x === p.x && y === p.y && dir.dirX === p.dirX && dir.dirY === p.dirY && !gatherDue;
    if (unchanged) continue;
    ctx.db.player.identity.update({
      ...p,
      x,
      y,
      dirX: dir.dirX,
      dirY: dir.dirY,
      path: "",
      movedAt: ctx.timestamp,
      lastEmberGatherAt: gatherDue ? ctx.timestamp : p.lastEmberGatherAt,
      // Bank charge on every write too, so a long-idle-then-inspected row never
      // has to replay a huge elapsed span in one derivation.
      kindlingCharge: bankedKindlingCharge(p, now),
      kindlingChargeAt: ctx.timestamp,
    });
  }
}
