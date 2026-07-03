import { type Coord, isWalkable, MOVE_SPEED_TILES_PER_SEC, RUN_SPEED_TILES_PER_SEC, type Zone } from "./constants";

/**
 * Position-over-time derivation, shared by server and client so both agree
 * exactly (no determinism mismatch — GDD "Movement"). Motion is an intent:
 * an origin (x, y), a WASD direction, and the moment it began. The position
 * after `elapsedMs` is the origin advanced along the direction at move speed,
 * clamped to the zone and sliding along walls. (0, 0) = idle.
 *
 * Movement is free 8-directional: a cardinal intent slides along its axis until
 * it hits a wall, the zone edge, or the clock runs out; a diagonal intent moves
 * at unit speed along the diagonal and **slides** — when one axis meets a wall,
 * the other keeps going (GDD "Movement"). Origins are fractional; nothing snaps
 * to tiles. Hogs still walk tile-to-tile with cardinal intents.
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
  /** Tile-footprint span anchored at (x, y) as the top-left corner: 1 for a trogg
   *  or common Hog, 2 for a big 2×2 Hog (GDD "Hogs"). Absent = 1. The footprint
   *  clamps against walls across its whole width/height, not a single tile. */
  size?: number;
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
 * it the mover is only clamped to the rectangular bounds (open floor). The mover
 * occupies a `size`×`size` footprint anchored at (x, y) as its top-left corner
 * (`size` from the `Motion`, default 1).
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
 * The tile a trogg pressing a **mostly-cardinal** direction would act on — or null
 * when it isn't lined up. With free movement a trogg is rarely exactly on a tile
 * and headings are camera-relative vectors, so "facing a tile" means: a press
 * whose minor axis is small next to its major (an oblique press faces nothing),
 * within `tol` of the lane on the perpendicular axis, and within `tol` of flush
 * along the movement axis (walking into a blocker clamps exactly flush, so a
 * deliberate push always qualifies). Pushing and interacting stay tile mechanics
 * on top of free movement.
 */
export function facingTile(x: number, y: number, dirX: number, dirY: number, tol = 0.35): Coord | null {
  const ax = Math.abs(dirX);
  const ay = Math.abs(dirY);
  if (ax === 0 && ay === 0) return null;
  if (Math.min(ax, ay) > Math.max(ax, ay) * 0.35) return null; // oblique — no square facing
  const tx = Math.round(x);
  const ty = Math.round(y);
  if (Math.abs(x - tx) > tol || Math.abs(y - ty) > tol) return null;
  return ax >= ay ? { x: tx + Math.sign(dirX), y: ty } : { x: tx, y: ty + Math.sign(dirY) };
}

/**
 * Wire scale for movement headings: a direction is an integer vector with each
 * axis in [-DIR_SCALE, DIR_SCALE] (the columns are i32). Only the vector's
 * *direction* matters — projection normalises, so magnitude never buys speed.
 * Hogs and legacy rows use plain ±1 vectors, which are just short headings.
 */
export const DIR_SCALE = 1000;

/** The four cardinal movement directions — the headings Hog wander picks from. */
export const CARDINALS: readonly { dirX: number; dirY: number }[] = [
  { dirX: 0, dirY: -1 },
  { dirX: 0, dirY: 1 },
  { dirX: -1, dirY: 0 },
  { dirX: 1, dirY: 0 },
];

/**
 * The cardinal directions a Hog at (x, y) could step onto — where its whole
 * `size`-tile footprint, shifted one tile that way, lands on walkable floor inside
 * the zone (GDD "Hogs"). The tile-by-tile wander reducer picks a Hog's heading from
 * these, so it ambles around walls, boulders, troggs, and other Hogs (whatever the
 * `ZoneBounds` `occupied` predicate marks unwalkable). For a 2×2 Hog the `occupied`
 * predicate must exclude the Hog's own footprint, else its next step (which overlaps
 * where it stands) reads as blocked. (x, y) is the footprint's top-left tile.
 */
export function walkableCardinals(zone: ZoneBounds, x: number, y: number, size = 1): { dirX: number; dirY: number }[] {
  return CARDINALS.filter(({ dirX, dirY }) => footprintWalkable(zone, x + dirX, y + dirY, size));
}

/** Whether the whole `size`-tile footprint anchored at top-left (x, y) is inside the
 *  zone and on walkable floor. (x, y, size) are tile units. */
export function footprintWalkable(zone: ZoneBounds, x: number, y: number, size = 1): boolean {
  if (x < 0 || y < 0 || x + size > zone.width || y + size > zone.height) return false;
  if (!zone.isWalkable) return true;
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
    if (!zone.isWalkable(x + dx, y + dy)) return false;
  }
  return true;
}

/** The tiles a `size`-tile footprint anchored at top-left (x, y) occupies — the one
 *  tile for a 1×1, the four tiles for a 2×2. Used to build collision sets. */
export function footprintTiles(x: number, y: number, size = 1): Coord[] {
  const tiles: Coord[] = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) tiles.push({ x: x + dx, y: y + dy });
  return tiles;
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
 * The tile nearest a position — the anchor the tile mechanics (interact, push,
 * attack targeting, drops) act from. Movement itself is free; a projected
 * footprint never overlaps an unwalkable cell, so the nearest tile is always
 * walkable floor.
 */
export function snapToTile(pos: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(pos.x), y: Math.round(pos.y) };
}

/**
 * Pick nearby free tiles in the same order the Commands panel spawn/drop helpers use:
 * the tile the player faces if it's free, then nearby free tiles around them, with
 * their own tile after the immediate neighbours. "Free" is a walkable floor tile
 * the `occupied` predicate doesn't claim. Idle players skip the facing preference and
 * take neighbours first, so entities land beside them rather than underfoot. Returned
 * tiles are unique. Server-authoritative (invariant 3); position is rounded to the
 * player's current tile first.
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

/** Pick the first free tile for one spawned or dropped thing. */
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
  const size = motion.size ?? 1;

  const p = slideAdvance(motion.x, motion.y, dirX, dirY, dist, zone, size);
  return { x: p.x, y: p.y, dirX, dirY, arrived: false };
}

/**
 * Advance a `size` footprint from (x, y) along the heading (dirX, dirY) for `dist`
 * tiles of travel, clamping against walls with slide — the one collision walker
 * every mover shares (WASD projection, path hops, line-of-sight tests). Cardinal
 * headings take exact single-axis clamps; anything else goes through the angled
 * segment walker.
 */
function slideAdvance(x: number, y: number, dirX: number, dirY: number, dist: number, zone: ZoneBounds, size: number): { x: number; y: number } {
  if (dirY === 0) {
    const step = Math.sign(dirX);
    const target = clamp(x + step * dist, 0, zone.width - size);
    return { x: zone.isWalkable ? wallX(zone, x, y, target, step, size) : target, y };
  }
  if (dirX === 0) {
    const step = Math.sign(dirY);
    const target = clamp(y + step * dist, 0, zone.height - size);
    return { x, y: zone.isWalkable ? wallY(zone, x, y, target, step, size) : target };
  }
  return projectAngled(x, y, dirX, dirY, dist, zone, size);
}

/**
 * Is the straight segment `from` → `to` fully walkable for a `size` footprint?
 * Answered by walking it with the shared collision walker: the line is clear
 * exactly when the walk arrives (any clamp or slide en route deviates from `to`),
 * so line-of-sight agrees byte-for-byte with how movement will actually execute.
 */
export function lineWalkable(zone: ZoneBounds, from: { x: number; y: number }, to: { x: number; y: number }, size = 1): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const hop = Math.hypot(dx, dy);
  if (hop < EPS) return true;
  const end = slideAdvance(from.x, from.y, dx, dy, hop, zone, size);
  return Math.hypot(end.x - to.x, end.y - to.y) < 1e-4;
}

/**
 * String-pull a cardinal A* route into the fewest straight hops (GDD "Movement"):
 * from the (fractional) start, greedily take the furthest waypoint reachable in a
 * straight line, then repeat from there. Open floor collapses to a single direct
 * glide; only genuine corners keep bends. The `path` wire format is unchanged —
 * waypoints just stop being adjacent.
 */
export function smoothPath(zone: ZoneBounds, start: { x: number; y: number }, path: readonly Coord[], size = 1): Coord[] {
  const out: Coord[] = [];
  let from = { x: start.x, y: start.y };
  let i = 0;
  while (i < path.length) {
    let j = path.length - 1;
    for (; j > i; j--) if (lineWalkable(zone, from, path[j]!, size)) break;
    out.push(path[j]!);
    from = path[j]!;
    i = j + 1;
  }
  return out;
}

/**
 * Off-axis movement with wall slide. The direction is any vector (camera-relative
 * headings quantise to ints on the wire; only its *direction* matters — the length
 * never affects speed): the trogg advances along the normalised heading, and when
 * one axis meets a wall (or the zone edge) the other keeps going. Advanced in
 * segments that end at each tile-boundary crossing, so the footprint's row/column
 * span — what the `wallX`/`wallY` clamps check against — is constant within a
 * segment; a pure function of its inputs, so client and server derive identically.
 */
function projectAngled(ox: number, oy: number, dirX: number, dirY: number, dist: number, zone: ZoneBounds, size: number): { x: number; y: number } {
  const len = Math.hypot(dirX, dirY);
  const nx = dirX / len; // per-axis share of unit speed along the heading
  const ny = dirY / len;
  const stepX = Math.sign(nx);
  const stepY = Math.sign(ny);
  let x = ox;
  let y = oy;
  let remaining = dist;
  let blockedX = false;
  let blockedY = false;
  const guard = Math.ceil(dist) * 4 + 8;

  for (let i = 0; i < guard && remaining > EPS; i++) {
    // Path length until each axis next crosses a tile boundary (∞ once blocked).
    const untilX = blockedX ? Number.POSITIVE_INFINITY : boundaryDistance(x, stepX, size) / Math.abs(nx);
    const untilY = blockedY ? Number.POSITIVE_INFINITY : boundaryDistance(y, stepY, size) / Math.abs(ny);
    const segment = Math.min(remaining, untilX, untilY);

    if (!blockedX) {
      const target = clamp(x + nx * segment, 0, zone.width - size);
      const cx = zone.isWalkable ? wallX(zone, x, y, target, stepX, size) : target;
      blockedX = stepX > 0 ? cx < target - EPS : cx > target + EPS;
      x = cx;
    }
    if (!blockedY) {
      const target = clamp(y + ny * segment, 0, zone.height - size);
      const cy = zone.isWalkable ? wallY(zone, x, y, target, stepY, size) : target;
      blockedY = stepY > 0 ? cy < target - EPS : cy > target + EPS;
      y = cy;
    }
    if (blockedX && blockedY) break;
    remaining -= segment;
  }
  return { x, y };
}

/** Distance along one axis until the leading edge of a `size` footprint at `p`
 *  next crosses a tile boundary moving in `step` (always > 0, even from exactly
 *  on a boundary — that crossing already happened). */
function boundaryDistance(p: number, step: number, size: number): number {
  const edge = step > 0 ? p + size : p;
  const next = step > 0 ? Math.floor(edge + EPS) + 1 - edge : edge - (Math.ceil(edge - EPS) - 1);
  return Math.max(next, EPS * 2);
}

function projectPathMotion(motion: Motion, path: readonly Coord[], elapsedMs: number, zone: ZoneBounds): ProjectedMotion {
  const speed = motion.running ? RUN_SPEED_TILES_PER_SEC : MOVE_SPEED_TILES_PER_SEC;
  const size = motion.size ?? 1;
  let remaining = (speed * Math.max(elapsedMs, 0)) / 1000;
  let current = { x: motion.x, y: motion.y };

  for (const next of path) {
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    const hop = Math.hypot(dx, dy);
    if (hop < EPS) continue; // already standing on this waypoint

    if (remaining <= hop) {
      // Mid-hop: glide along the segment through the live collision walker, so an
      // obstacle that arrived after routing (a Hog, a shoved boulder) clamps the
      // glide instead of being passed through. A clamp or slide means the hop is
      // no longer clean — report no heading, which is the stall signal the client
      // re-routes on. Hops already consumed are behind us: forward-only projection,
      // so a Hog landing on ground already covered never rewinds the trogg.
      const end = slideAdvance(current.x, current.y, dx, dy, remaining, zone, size);
      const expectedX = current.x + (dx / hop) * remaining;
      const expectedY = current.y + (dy / hop) * remaining;
      const clean = Math.hypot(end.x - expectedX, end.y - expectedY) < 1e-4;
      return { x: end.x, y: end.y, dirX: clean ? dx / hop : 0, dirY: clean ? dy / hop : 0, arrived: false };
    }
    remaining -= hop;
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
 * Clamp a rightward/leftward slide so a `size`-tile footprint anchored at (ox, oy)
 * never enters an unwalkable tile. The footprint spans the tile rows `[r0, r1]` its
 * height overlaps (one extra row when mid-tile); a column blocks if any of those
 * rows is unwalkable. A blocking column `k` stops the origin at `k - size` going
 * right (the footprint's right edge ends at `k`), or `k + 1` going left.
 */
function wallX(zone: ZoneBounds, ox: number, oy: number, target: number, step: number, size: number): number {
  const r0 = Math.floor(oy + EPS);
  const r1 = Math.ceil(oy + size - EPS) - 1;
  if (step > 0) {
    const from = Math.ceil(ox + size - EPS) - 1; // rightmost occupied column
    for (let k = from + 1; k <= zone.width - 1; k++) {
      if (!colWalkable(zone, k, r0, r1)) return Math.min(target, k - size);
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
function wallY(zone: ZoneBounds, ox: number, oy: number, target: number, step: number, size: number): number {
  const c0 = Math.floor(ox + EPS);
  const c1 = Math.ceil(ox + size - EPS) - 1;
  if (step > 0) {
    const from = Math.ceil(oy + size - EPS) - 1; // lowest occupied row
    for (let k = from + 1; k <= zone.height - 1; k++) {
      if (!rowWalkable(zone, k, c0, c1)) return Math.min(target, k - size);
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
