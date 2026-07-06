import { deriveAfkCharge, type Stamp } from "../../shared/index";
import { isLitTile, nearestLitBrazier } from "./brazier";
import type { Ctx } from "./schema";

/** The player-row slice `touchAfkCharge`/`settlePresence` read and write.
 *  The columns keep their shipped `kindling*` names (additive-only schema). */
type AfkCharge<S extends Stamp> = { kindlingCharge: number; kindlingChargeAt: S };

/**
 * Re-base a trogg's AFK charge to now, accruing for the active play
 * since its last touch (GDD "The fire and the dark" → Presence). Called from
 * every reducer that represents real input over real time (invariant 2's
 * grammar) — movement and facing — never on a timer (invariant 1). Generic
 * over the caller's concrete timestamp type so the row keeps the real
 * `Timestamp` SpacetimeDB expects, not the narrower `Stamp` shape.
 */
export function touchAfkCharge<S extends Stamp>(p: AfkCharge<S>, now: S): AfkCharge<S> {
  return { kindlingCharge: deriveAfkCharge(p.kindlingCharge, p.kindlingChargeAt, true, now), kindlingChargeAt: now };
}

/**
 * Where a disconnecting trogg ends up and what it carries forward (GDD "The
 * fire and the dark" → Presence). Finalizes the last stretch of active play
 * into its charge; with charge left and already on lit ground it stays put
 * and goes AFK in place, otherwise it's recalled to the nearest hearth
 * before going AFK. `recalled` tells the caller whether the trogg actually
 * left where it settled, so a carried object rides along instead of
 * dropping at an abandoned spot.
 */
export function settlePresence<S extends Stamp>(
  ctx: Ctx,
  p: { zoneId: string } & AfkCharge<S>,
  at: { x: number; y: number; z: number },
  now: S,
): { x: number; y: number; z: number; kindlingCharge: number; kindlingChargeAt: S; recalled: boolean } {
  const charge = deriveAfkCharge(p.kindlingCharge, p.kindlingChargeAt, true, now);
  if (charge > 0 && isLitTile(ctx, p.zoneId, Math.round(at.x), Math.round(at.y))) {
    return { x: at.x, y: at.y, z: at.z, kindlingCharge: charge, kindlingChargeAt: now, recalled: false };
  }
  const hearth = nearestLitBrazier(ctx, p.zoneId, at.x, at.y);
  return {
    x: hearth?.x ?? at.x,
    y: hearth?.y ?? at.y,
    z: 0,
    kindlingCharge: charge,
    kindlingChargeAt: now,
    recalled: true,
  };
}
