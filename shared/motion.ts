import { type Coord, isWalkable, MOVE_SPEED_TILES_PER_SEC, type Zone } from "./constants";

/**
 * Position-over-time derivation, shared by server and client so both agree
 * exactly (no determinism mismatch — GDD "Movement"). Motion is an intent:
 * an origin (x, y), a WASD direction, and the moment it began. The position
 * after `elapsedMs` is the origin advanced along the direction at move speed,
 * clamped to the zone and to the first unwalkable tile in the way. (0, 0) = idle.
 *
 * Movement is 4-directional (cardinal only — no diagonals), so exactly one axis
 * is ever non-zero; the trogg slides along that axis until it hits a wall, the
 * zone edge, or the clock runs out (GDD: "WASD clamps at the first unwalkable
 * tile or the zone edge").
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

/**
 * Zone collision context for `projectMotion`. `isWalkable` is optional: without
 * it the trogg is only clamped to the rectangular bounds (open floor). The
 * trogg occupies a 1×1 tile footprint anchored at (x, y).
 */
export interface ZoneBounds {
  width: number;
  height: number;
  isWalkable?(tileX: number, tileY: number): boolean;
}

/**
 * Build the collision context for a zone, wiring its tilemap walkability. Pass
 * `occupied` to add dynamic obstacles (boulders): a tile is walkable only if the
 * static tilemap allows it *and* nothing occupies it. The same builder is used by
 * the client (reading its subscribed boulder rows) and the server (reading the
 * boulder table), so prediction and authority agree (invariant 3).
 */
export function zoneBounds(zone: Zone, occupied?: (tileX: number, tileY: number) => boolean): ZoneBounds {
  return {
    width: zone.width,
    height: zone.height,
    isWalkable: (x, y) => isWalkable(zone, x, y) && !(occupied?.(x, y) ?? false),
  };
}

/**
 * The tile a trogg would push into, given its position and cardinal direction —
 * or null if it isn't squarely on a tile. Pushing (GDD "Pushing") requires the
 * trogg to be tile-aligned and flush, so a boulder only gives way when you line
 * up and walk straight into it, like the block puzzles in classic top-down games.
 * `tol` absorbs float noise in the derived position.
 */
export function facingTile(x: number, y: number, dirX: number, dirY: number, tol = 0.1): Coord | null {
  if (dirX === 0 && dirY === 0) return null;
  const tx = Math.round(x);
  const ty = Math.round(y);
  if (Math.abs(x - tx) > tol || Math.abs(y - ty) > tol) return null;
  return { x: tx + Math.sign(dirX), y: ty + Math.sign(dirY) };
}

/** The four cardinal movement directions — the only headings the game allows. */
export const CARDINALS: readonly { dirX: number; dirY: number }[] = [
  { dirX: 0, dirY: -1 },
  { dirX: 0, dirY: 1 },
  { dirX: -1, dirY: 0 },
  { dirX: 1, dirY: 0 },
];

/**
 * The cardinal directions whose next tile a Hog at (x, y) could step onto —
 * walkable floor inside the zone (GDD "Hogs"). The scheduled wander reducer picks
 * a Hog's new heading from these, so it ambles around walls and boulders instead
 * of pressing into them. (x, y) are tile coordinates.
 */
export function walkableCardinals(zone: ZoneBounds, x: number, y: number): { dirX: number; dirY: number }[] {
  return CARDINALS.filter(({ dirX, dirY }) => {
    const nx = x + dirX;
    const ny = y + dirY;
    if (nx < 0 || ny < 0 || nx >= zone.width || ny >= zone.height) return false;
    return zone.isWalkable ? zone.isWalkable(nx, ny) : true;
  });
}

/**
 * Pick a tile to drop a spawned entity on (the debug `/spawn` command): the tile
 * the player faces if it's free, else the nearest free orthogonal neighbour, else
 * the player's own tile — or null if every candidate is blocked. "Free" is a
 * walkable floor tile the `occupied` predicate doesn't claim (so a boulder never
 * spawns inside a wall or on another boulder). Idle players (no direction) skip
 * the facing tile and take a neighbour, so the entity lands beside them rather
 * than underfoot. Server-authoritative (invariant 3); position is rounded to the
 * player's current tile first.
 */
export function spawnTile(
  zone: Zone,
  occupied: (tileX: number, tileY: number) => boolean,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
): Coord | null {
  const px = Math.round(x);
  const py = Math.round(y);
  const free = (tx: number, ty: number) => isWalkable(zone, tx, ty) && !occupied(tx, ty);

  const candidates: Coord[] = [];
  if (dirX !== 0 || dirY !== 0) candidates.push({ x: px + Math.sign(dirX), y: py + Math.sign(dirY) });
  candidates.push({ x: px + 1, y: py }, { x: px - 1, y: py }, { x: px, y: py + 1 }, { x: px, y: py - 1 }, { x: px, y: py });

  for (const c of candidates) if (free(c.x, c.y)) return c;
  return null;
}

/** Slack to keep tile-boundary floats off the edge when deriving a footprint. */
const EPS = 1e-6;

export function projectMotion(motion: Motion, elapsedMs: number, zone: ZoneBounds): { x: number; y: number } {
  const { dirX, dirY } = motion;
  if (dirX === 0 && dirY === 0) return { x: motion.x, y: motion.y };

  const dist = (MOVE_SPEED_TILES_PER_SEC * Math.max(elapsedMs, 0)) / 1000;

  // Cardinal: exactly one axis moves. Clamp to bounds, then to the first wall.
  if (dirX !== 0) {
    const step = Math.sign(dirX);
    const target = clamp(motion.x + step * dist, 0, zone.width - 1);
    return { x: zone.isWalkable ? wallX(zone, motion.x, motion.y, target, step) : target, y: motion.y };
  }
  const step = Math.sign(dirY);
  const target = clamp(motion.y + step * dist, 0, zone.height - 1);
  return { x: motion.x, y: zone.isWalkable ? wallY(zone, motion.x, motion.y, target, step) : target };
}

/**
 * Clamp a rightward/leftward slide so the trogg's footprint never enters an
 * unwalkable tile. The footprint spans the tile rows `[r0, r1]` its height
 * overlaps (one row when y is tile-aligned, two when mid-tile); a column blocks
 * if any of those rows is unwalkable there.
 */
function wallX(zone: ZoneBounds, ox: number, oy: number, target: number, step: number): number {
  const r0 = Math.floor(oy + EPS);
  const r1 = Math.ceil(oy + 1 - EPS) - 1;
  if (step > 0) {
    const from = Math.ceil(ox + 1 - EPS) - 1; // rightmost occupied column
    for (let k = from + 1; k <= zone.width - 1; k++) {
      if (!colWalkable(zone, k, r0, r1)) return Math.min(target, k - 1);
    }
    return target;
  }
  const from = Math.floor(ox + EPS); // leftmost occupied column
  for (let k = from - 1; k >= 0; k--) {
    if (!colWalkable(zone, k, r0, r1)) return Math.max(target, k + 1);
  }
  return target;
}

/** Vertical counterpart of `wallX`: the footprint spans tile columns `[c0, c1]`. */
function wallY(zone: ZoneBounds, ox: number, oy: number, target: number, step: number): number {
  const c0 = Math.floor(ox + EPS);
  const c1 = Math.ceil(ox + 1 - EPS) - 1;
  if (step > 0) {
    const from = Math.ceil(oy + 1 - EPS) - 1; // lowest occupied row
    for (let k = from + 1; k <= zone.height - 1; k++) {
      if (!rowWalkable(zone, k, c0, c1)) return Math.min(target, k - 1);
    }
    return target;
  }
  const from = Math.floor(oy + EPS); // topmost occupied row
  for (let k = from - 1; k >= 0; k--) {
    if (!rowWalkable(zone, k, c0, c1)) return Math.max(target, k + 1);
  }
  return target;
}

/** Is column `col` walkable across every footprint row `r0..r1`? */
function colWalkable(zone: ZoneBounds, col: number, r0: number, r1: number): boolean {
  for (let r = r0; r <= r1; r++) if (!zone.isWalkable!(col, r)) return false;
  return true;
}

/** Is row `row` walkable across every footprint column `c0..c1`? */
function rowWalkable(zone: ZoneBounds, row: number, c0: number, c1: number): boolean {
  for (let c = c0; c <= c1; c++) if (!zone.isWalkable!(c, row)) return false;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
