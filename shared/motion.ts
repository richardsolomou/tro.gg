import { type Coord, isWalkable, MOVE_SPEED_TILES_PER_SEC, RUN_SPEED_TILES_PER_SEC, type Zone } from "./constants";

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
  /** Serialized click-to-move path waypoints (`"x,y;x,y"`), excluding the current
   *  origin; an empty/missing path means direct WASD-style motion. */
  path?: string;
  /** Holding shift runs at `RUN_SPEED_TILES_PER_SEC` instead of walking (GDD
   *  "Movement"). Part of the intent so every client derives the same speed;
   *  absent/false = walk. Hogs never set it, so they always walk. */
  running?: boolean;
}

export interface ProjectedMotion {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  arrived: boolean;
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
 * walkable floor inside the zone (GDD "Hogs"). The tile-by-tile wander reducer picks
 * a Hog's heading from these, so it ambles around walls, boulders, troggs, and other
 * Hogs (whatever the `ZoneBounds` `occupied` predicate marks unwalkable) instead of
 * pressing into them. (x, y) are tile coordinates.
 */
export function walkableCardinals(zone: ZoneBounds, x: number, y: number): { dirX: number; dirY: number }[] {
  return CARDINALS.filter(({ dirX, dirY }) => {
    const nx = x + dirX;
    const ny = y + dirY;
    if (nx < 0 || ny < 0 || nx >= zone.width || ny >= zone.height) return false;
    return zone.isWalkable ? zone.isWalkable(nx, ny) : true;
  });
}

/** Serialize click-to-move waypoints into the player row's path string. */
export function serializePath(path: readonly Coord[]): string {
  return path.map((p) => `${p.x},${p.y}`).join(";");
}

/** Parse the player row's path string. Malformed waypoints are ignored. */
export function parsePath(path: string | undefined): Coord[] {
  if (!path) return [];
  const points: Coord[] = [];
  for (const part of path.split(";")) {
    const [rawX, rawY] = part.split(",");
    if (rawX == null || rawY == null) continue;
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

/**
 * Server-side click-to-move pathfinding (GDD "Movement"). Finds the shortest
 * cardinal route from `start` to `target` over the zone's current walkable tiles,
 * returning waypoints after `start`. If the target tile is blocked, it routes to
 * the nearest reachable cardinal neighbour instead, so obstacle clicks still get
 * the trogg as close as possible.
 */
export function findPath(zone: ZoneBounds, start: Coord, target: Coord): Coord[] {
  if (!inBounds(zone, target.x, target.y)) return [];

  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  if (!tileWalkable(zone, sx, sy)) return [];

  const candidates = candidateTargets(zone, target);
  if (candidates.length === 0) return [];

  const candidateKeys = new Set(candidates.map((p) => tileKey(p.x, p.y)));
  if (candidateKeys.has(tileKey(sx, sy))) return [];

  const open: PathNode[] = [{ x: sx, y: sy, g: 0, f: heuristicToAny({ x: sx, y: sy }, candidates), from: "" }];
  const best = new Map<string, PathNode>();
  best.set(tileKey(sx, sy), open[0]!);
  const closed = new Set<string>();

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f || a.g - b.g);
    const current = open.shift()!;
    const currentKey = tileKey(current.x, current.y);
    if (closed.has(currentKey)) continue;
    if (candidateKeys.has(currentKey)) return reconstructPath(best, currentKey, tileKey(sx, sy));
    closed.add(currentKey);

    for (const { dirX, dirY } of CARDINALS) {
      const nx = current.x + dirX;
      const ny = current.y + dirY;
      if (!tileWalkable(zone, nx, ny)) continue;
      const nextKey = tileKey(nx, ny);
      if (closed.has(nextKey)) continue;
      const g = current.g + 1;
      const existing = best.get(nextKey);
      if (existing && existing.g <= g) continue;
      const next: PathNode = { x: nx, y: ny, g, f: g + heuristicToAny({ x: nx, y: ny }, candidates), from: currentKey };
      best.set(nextKey, next);
      open.push(next);
    }
  }

  return [];
}

/**
 * The tile centre nearest a position — a trogg's grid-locked resting place.
 * Movement is tile-to-tile (GDD "Movement", Pokémon/Zelda style), so a settled
 * origin is always a whole tile, never a fractional point on one. A trogg only
 * ever slides along one axis between integer tiles, and every tile it crosses is
 * walkable (`projectMotion` stops at the first that isn't), so rounding always
 * lands on walkable floor.
 */
export function snapToTile(pos: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(pos.x), y: Math.round(pos.y) };
}

/**
 * Pick tiles to drop spawned entities on (the debug `/spawn` command): the tile
 * the player faces if it's free, then nearby free tiles around them, with their
 * own tile after the immediate neighbours. "Free" is a walkable floor tile the
 * `occupied` predicate doesn't claim. Idle players skip the facing preference and
 * take neighbours first, so entities land beside them rather than underfoot.
 * Returned tiles are unique. Server-authoritative (invariant 3); position is
 * rounded to the player's current tile first.
 */
export function spawnTiles(
  zone: Zone,
  occupied: (tileX: number, tileY: number) => boolean,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  count: number,
): Coord[] {
  const px = Math.round(x);
  const py = Math.round(y);
  const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const free = (tx: number, ty: number) => isWalkable(zone, tx, ty) && !occupied(tx, ty);
  const tiles: Coord[] = [];
  const seen = new Set<string>();

  const add = (tx: number, ty: number) => {
    if (tiles.length >= wanted) return;
    const key = `${tx},${ty}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (free(tx, ty)) tiles.push({ x: tx, y: ty });
  };

  if (dirX !== 0 || dirY !== 0) add(px + Math.sign(dirX), py + Math.sign(dirY));
  add(px + 1, py);
  add(px - 1, py);
  add(px, py + 1);
  add(px, py - 1);
  add(px, py);

  const maxRadius = zone.width + zone.height;
  for (let radius = 2; tiles.length < wanted && radius <= maxRadius; radius++) {
    for (let dy = -radius; dy <= radius && tiles.length < wanted; dy++) {
      const dx = radius - Math.abs(dy);
      if (dx === 0) {
        add(px, py + dy);
      } else {
        add(px + dx, py + dy);
        add(px - dx, py + dy);
      }
    }
  }

  return tiles;
}

/** Single-tile compatibility wrapper for the original `/spawn <entity>` command. */
export function spawnTile(
  zone: Zone,
  occupied: (tileX: number, tileY: number) => boolean,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
): Coord | null {
  return spawnTiles(zone, occupied, x, y, dirX, dirY, 1)[0] ?? null;
}

/** Slack to keep tile-boundary floats off the edge when deriving a footprint. */
const EPS = 1e-6;

export function projectMotion(motion: Motion, elapsedMs: number, zone: ZoneBounds): { x: number; y: number } {
  const projected = projectMotionState(motion, elapsedMs, zone);
  return { x: projected.x, y: projected.y };
}

export function projectMotionState(motion: Motion, elapsedMs: number, zone: ZoneBounds): ProjectedMotion {
  const path = parsePath(motion.path);
  if (path.length > 0) return projectPathMotion(motion, path, elapsedMs, zone);

  const { dirX, dirY } = motion;
  if (dirX === 0 && dirY === 0) return { x: motion.x, y: motion.y, dirX: 0, dirY: 0, arrived: true };

  const speed = motion.running ? RUN_SPEED_TILES_PER_SEC : MOVE_SPEED_TILES_PER_SEC;
  const dist = (speed * Math.max(elapsedMs, 0)) / 1000;

  // Cardinal: exactly one axis moves. Clamp to bounds, then to the first wall.
  if (dirX !== 0) {
    const step = Math.sign(dirX);
    const target = clamp(motion.x + step * dist, 0, zone.width - 1);
    return { x: zone.isWalkable ? wallX(zone, motion.x, motion.y, target, step) : target, y: motion.y, dirX, dirY, arrived: false };
  }
  const step = Math.sign(dirY);
  const target = clamp(motion.y + step * dist, 0, zone.height - 1);
  return { x: motion.x, y: zone.isWalkable ? wallY(zone, motion.x, motion.y, target, step) : target, dirX, dirY, arrived: false };
}

function projectPathMotion(motion: Motion, path: readonly Coord[], elapsedMs: number, zone: ZoneBounds): ProjectedMotion {
  const speed = motion.running ? RUN_SPEED_TILES_PER_SEC : MOVE_SPEED_TILES_PER_SEC;
  let remaining = (speed * Math.max(elapsedMs, 0)) / 1000;
  let current = { x: motion.x, y: motion.y };

  for (const next of path) {
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) {
      return { ...current, dirX: 0, dirY: 0, arrived: true };
    }
    const dirX = Math.sign(dx);
    const dirY = Math.sign(dy);
    if (remaining <= 1) {
      // Stepping into `next`: block only on the tile we're entering. Tiles already
      // traversed (consumed in the branch below) are behind us, so an obstacle that
      // lands on one never rewinds us — it can only stop us going further. This is
      // what keeps a Hog wandering onto a tile you've already crossed from snapping
      // you back to it (forward-only projection; re-route handled by the client).
      if (!tileWalkable(zone, next.x, next.y)) {
        return { ...current, dirX: 0, dirY: 0, arrived: false };
      }
      return { x: current.x + dirX * remaining, y: current.y + dirY * remaining, dirX, dirY, arrived: false };
    }
    remaining -= 1;
    current = { x: next.x, y: next.y };
  }

  return { ...current, dirX: 0, dirY: 0, arrived: true };
}

interface PathNode extends Coord {
  g: number;
  f: number;
  from: string;
}

/**
 * The tiles a click-to-move route may end on for `target`: the target itself if it's
 * walkable, otherwise its walkable cardinal neighbours (nearest first). Exported so the
 * client can tell "as close as I can get" from "still blocked en route" and stop a
 * retry loop once the trogg sits on one of these.
 */
export function candidateTargets(zone: ZoneBounds, target: Coord): Coord[] {
  const tx = Math.round(target.x);
  const ty = Math.round(target.y);
  if (tileWalkable(zone, tx, ty)) return [{ x: tx, y: ty }];

  return CARDINALS.map(({ dirX, dirY }) => ({ x: tx + dirX, y: ty + dirY }))
    .filter((p) => tileWalkable(zone, p.x, p.y))
    .sort((a, b) => heuristic(a, target) - heuristic(b, target));
}

function reconstructPath(nodes: Map<string, PathNode>, endKey: string, startKey: string): Coord[] {
  const path: Coord[] = [];
  let key = endKey;
  while (key !== startKey) {
    const node = nodes.get(key);
    if (!node) return [];
    path.push({ x: node.x, y: node.y });
    key = node.from;
  }
  path.reverse();
  return path;
}

function heuristicToAny(from: Coord, targets: readonly Coord[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const target of targets) best = Math.min(best, heuristic(from, target));
  return best;
}

function heuristic(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function tileWalkable(zone: ZoneBounds, x: number, y: number): boolean {
  return inBounds(zone, x, y) && (zone.isWalkable ? zone.isWalkable(x, y) : true);
}

function inBounds(zone: ZoneBounds, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < zone.width && y < zone.height;
}

/** The "x,y" occupancy key for a tile. Client and server must agree on this format —
 *  it keys the `zoneBounds` occupied predicate on both sides — so it lives here, once. */
export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
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
