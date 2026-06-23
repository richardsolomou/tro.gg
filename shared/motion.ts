import { MOVE_SPEED_TILES_PER_SEC } from "./constants";

/**
 * Position-over-time derivation, shared by server and client so both agree
 * exactly (no determinism mismatch — GDD "Movement"). Motion is an intent:
 * an origin (x, y), a WASD direction, and the moment it began. The position
 * after `elapsedMs` is the origin advanced along the direction at move speed,
 * clamped to the zone. (0, 0) = idle.
 *
 * The server passes elapsed against its own clock to settle the origin on each
 * input transition; the client passes elapsed since it received the intent to
 * extrapolate between diffs.
 */
export interface Motion {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
}

export interface ZoneBounds {
  width: number;
  height: number;
}

export function projectMotion(motion: Motion, elapsedMs: number, zone: ZoneBounds): { x: number; y: number } {
  if (motion.dirX === 0 && motion.dirY === 0) return { x: motion.x, y: motion.y };

  const len = Math.hypot(motion.dirX, motion.dirY);
  const dist = (MOVE_SPEED_TILES_PER_SEC * Math.max(elapsedMs, 0)) / 1000;
  return {
    x: clamp(motion.x + (motion.dirX / len) * dist, 0, zone.width - 1),
    y: clamp(motion.y + (motion.dirY / len) * dist, 0, zone.height - 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
