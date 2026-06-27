import type { Player } from "./net/module_bindings/types";

type MotionRow = Pick<Player, "x" | "y" | "dirX" | "dirY" | "running" | "path" | "movedAt">;

/** True when a player row update changes the intent fields used for position extrapolation. */
export function playerMotionChanged(a: MotionRow, b: MotionRow): boolean {
  return (
    a.x !== b.x ||
    a.y !== b.y ||
    a.dirX !== b.dirX ||
    a.dirY !== b.dirY ||
    a.running !== b.running ||
    a.path !== b.path ||
    a.movedAt.microsSinceUnixEpoch !== b.movedAt.microsSinceUnixEpoch
  );
}

export function isOlderPlayerMotion(incoming: MotionRow, current: MotionRow): boolean {
  return incoming.movedAt.microsSinceUnixEpoch < current.movedAt.microsSinceUnixEpoch;
}

export function withPlayerMotion(p: Player, motion: MotionRow): Player {
  return {
    ...p,
    x: motion.x,
    y: motion.y,
    dirX: motion.dirX,
    dirY: motion.dirY,
    running: motion.running,
    path: motion.path,
    movedAt: motion.movedAt,
  };
}
