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
