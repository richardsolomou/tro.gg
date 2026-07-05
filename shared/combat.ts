/**
 * Melee reach (GDD "Combat"). Free movement made exact-tile adjacency miss what
 * the eye says is in reach, so a swing resolves as geometry instead: it hits the
 * nearest target whose hit circle is within reach of the attacker and inside the
 * swing's aim cone. Deterministic and input-driven — the client sends its aim
 * vector once per use, the server re-derives every position (invariant 3).
 */

/** How far a swing reaches, attacker centre to target hit-circle edge, in tiles. */
export const MELEE_RANGE_TILES = 1.7;

/** Half-angle of the swing cone around the aim vector. */
export const MELEE_ARC_RAD = (55 * Math.PI) / 180;

/** Inside this centre distance the angle check is waived — a scuffle at arm's
 *  length hits regardless of exact aim. */
export const MELEE_POINT_BLANK_TILES = 0.75;

/** Hit-circle radii in tiles. */
export const PLAYER_HIT_RADIUS = 0.45;
export const BOULDER_HIT_RADIUS = 0.5;
export const TREE_HIT_RADIUS = 0.5;

export interface HitCircle {
  x: number;
  y: number;
  radius: number;
}

/**
 * The centre distance at which a swing from (x, y) along (dirX, dirY) reaches the
 * target's hit circle, or undefined on a miss. Coordinates are centres in tile
 * units; the aim vector needs no particular magnitude. The cone widens by the
 * angle the target's radius subtends, so a big target half-out of the cone still
 * takes the hit its silhouette suggests.
 */
export function meleeHit(x: number, y: number, dirX: number, dirY: number, target: HitCircle): number | undefined {
  const dx = target.x - x;
  const dy = target.y - y;
  const dist = Math.hypot(dx, dy);
  if (dist - target.radius > MELEE_RANGE_TILES) return undefined;
  if (dist <= Math.max(MELEE_POINT_BLANK_TILES, target.radius)) return dist;
  const len = Math.hypot(dirX, dirY);
  if (len === 0) return undefined;
  const toward = (dx * dirX + dy * dirY) / (dist * len);
  const angle = Math.acos(Math.min(1, Math.max(-1, toward)));
  const halo = Math.asin(Math.min(1, target.radius / dist));
  return angle <= MELEE_ARC_RAD + halo ? dist : undefined;
}
