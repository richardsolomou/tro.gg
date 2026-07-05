import { Timestamp } from "spacetimedb";
import {
  BOULDER_HIT_RADIUS,
  TREE_HIT_RADIUS,
  DIR_SCALE,
  elapsedMs,
  meleeHit,
  PLAYER_HIT_RADIUS,
  getZone,
  BOULDER_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  projectMotion,
  projectMotionState,
  snapToTile,
  spawnTile,
  type Stamp,
  tileKey,
  type Zone,
  zoneBounds,
} from "../../shared/index";
import type { Ctx } from "./schema";

/** A fresh trogg's spawn tile: the zone's spawn point (the zone centre when unset). */
export function spawnAt(zone: Zone): { x: number; y: number } {
  return zone.spawn ?? { x: Math.floor(zone.width / 2), y: Math.floor(zone.height / 2) };
}

/** The motion-bearing slice of a player row that `settle` derives position from.
 *  The cheat and altitude fields ride along so the projection applies the same
 *  speed, clearance, and z derivation authority-side (GDD "Debug cheats"). */
type Settleable = {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  running: boolean;
  path?: string;
  zoneId: string;
  movedAt: Stamp;
  cheatSpeed?: number;
  cheatFly?: boolean;
  cheatNoclip?: boolean;
  z?: number;
  dirZ?: number;
};

/**
 * Derive the trogg's position at `now` from its stored motion intent, colliding
 * against everything solid to a trogg — walls and boulders — so it settles flush
 * against an obstacle, never inside one. Movement is free (GDD "Movement"), so
 * origins are fractional; the projection is the only authority on where the
 * trogg is, and a client can't gain distance by re-basing (invariant 3). Troggs
 * do *not* collide with each other, so other players are absent here.
 */
export function settle(ctx: Ctx, p: Settleable, now: Stamp): { x: number; y: number; z: number } {
  const zone = getZone(p.zoneId);
  if (!zone) return { x: p.x, y: p.y, z: p.z ?? 0 };
  const blockers = troggBlockers(ctx, p.zoneId, now);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  const at = projectMotionState(p, elapsedMs(p.movedAt, now), bounds);
  return { x: at.x, y: at.y, z: at.z };
}

/** Count rows in a table iterable without materializing an array. */
export function countRows(rows: Iterable<unknown>): number {
  let n = 0;
  for (const _ of rows) n++;
  return n;
}

/** The set of tiles occupied by static obstacles — boulders and trees — in a
 *  zone, keyed by `tileKey`. The base layer every blocker set builds on. */
export function obstacleTiles(ctx: Ctx, zoneId: string): Set<string> {
  const tiles = new Set<string>();
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) tiles.add(tileKey(b.x, b.y));
  for (const tr of ctx.db.tree.zoneId.filter(zoneId)) tiles.add(tileKey(tr.x, tr.y));
  return tiles;
}

/** The tiles solid to a trogg in a zone: boulders. Not other troggs — trogg↔trogg
 *  has no collision. */
export function troggBlockers(ctx: Ctx, zoneId: string, now: Stamp): Set<string> {
  return obstacleTiles(ctx, zoneId);
}

/** Add each online trogg's current tile (projected to `now`, against walls + boulders)
 *  to `set`, skipping `exclude` (a trogg never blocks itself). Lets dropped objects
 *  avoid the tiles troggs stand on. */
export function addPlayerTiles(ctx: Ctx, zoneId: string, now: Stamp, set: Set<string>, exclude?: Ctx["sender"]): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  const blockers = troggBlockers(ctx, zoneId, now);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  for (const p of ctx.db.player.zoneId.filter(zoneId)) {
    if (!p.online) continue;
    if (exclude && p.identity.isEqual(exclude)) continue;
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    set.add(tileKey(Math.round(pos.x), Math.round(pos.y)));
  }
}

/** Every solid tile a freshly placed entity must avoid — boulders and other
 *  troggs — so a spawn or drop never lands on top of something. `exclude` skips the
 *  acting trogg's own tile, leaving it as a last-resort fallback when boxed in. */
export function solidTiles(ctx: Ctx, zoneId: string, now: Stamp, exclude?: Ctx["sender"]): Set<string> {
  const tiles = obstacleTiles(ctx, zoneId);
  addPlayerTiles(ctx, zoneId, now, tiles, exclude);
  return tiles;
}

/** Mark existing pickup items as visually occupied for new debug spawns. */
export function addGroundItemTiles(ctx: Ctx, zoneId: string, set: Set<string>): void {
  for (const item of ctx.db.groundItem.zoneId.filter(zoneId)) set.add(tileKey(item.x, item.y));
}

/** The boulder at a tile in a zone, or undefined. */
export function boulderAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) {
    if (b.x === x && b.y === y) return b;
  }
  return undefined;
}

/** The tree at a tile in a zone, or undefined. */
export function treeAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const tr of ctx.db.tree.zoneId.filter(zoneId)) {
    if (tr.x === x && tr.y === y) return tr;
  }
  return undefined;
}

/** The pickup item at a tile in a zone, or undefined. */
export function groundItemAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const item of ctx.db.groundItem.zoneId.filter(zoneId)) {
    if (item.x === x && item.y === y) return item;
  }
  return undefined;
}

/** The nearest ground item within `radius` tiles of (cx, cy), centre to centre —
 *  `E` reaches loot by distance, not facing, so a drop at your feet always lifts. */
export function nearestGroundItem(ctx: Ctx, zoneId: string, cx: number, cy: number, radius: number) {
  let best: { row: NonNullable<ReturnType<typeof groundItemAt>>; dist: number } | undefined;
  for (const item of ctx.db.groundItem.zoneId.filter(zoneId)) {
    const dist = Math.hypot(item.x + 0.5 - cx, item.y + 0.5 - cy);
    if (dist <= radius && (!best || dist < best.dist)) best = { row: item, dist };
  }
  return best?.row;
}

/**
 * The online, living trogg currently on a tile in a zone, or undefined. Troggs do
 * not collide with each other, but sword attacks need a server-authoritative target
 * under the faced adjacent tile. Project each candidate at `now` with the same
 * bounds a trogg uses for movement, then round to its rendered tile.
 */
export function playerAt(ctx: Ctx, zoneId: string, x: number, y: number, now: Stamp, exclude?: Ctx["sender"]) {
  const zone = getZone(zoneId);
  if (!zone) return undefined;
  const blockers = troggBlockers(ctx, zoneId, now);
  const bounds = zoneBounds(zone, (tx, ty) => blockers.has(tileKey(tx, ty)));
  for (const p of ctx.db.player.zoneId.filter(zoneId)) {
    if (!p.online || p.dead) continue;
    if (exclude && p.identity.isEqual(exclude)) continue;
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    if (Math.round(pos.x) === x && Math.round(pos.y) === y) return p;
  }
  return undefined;
}

/**
 * Melee target selection (GDD "Combat"): the nearest candidate whose hit circle a
 * swing from `cx, cy` along `aim` reaches (`meleeHit` in shared). Positions are
 * re-derived server-side with the same projections the client renders, so what
 * looks in reach is in reach (invariant 3). Centres are tile origin + half the
 * footprint.
 */
export function meleePlayerTarget(ctx: Ctx, zoneId: string, cx: number, cy: number, aim: { dirX: number; dirY: number }, now: Stamp, exclude: Ctx["sender"]) {
  const zone = getZone(zoneId);
  if (!zone) return undefined;
  const blockers = troggBlockers(ctx, zoneId, now);
  const bounds = zoneBounds(zone, (tx, ty) => blockers.has(tileKey(tx, ty)));
  let best: { target: NonNullable<ReturnType<typeof playerAt>>; dist: number } | undefined;
  for (const p of ctx.db.player.zoneId.filter(zoneId)) {
    if (!p.online || p.dead) continue;
    if (p.identity.isEqual(exclude)) continue;
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    const dist = meleeHit(cx, cy, aim.dirX, aim.dirY, { x: pos.x + 0.5, y: pos.y + 0.5, radius: PLAYER_HIT_RADIUS });
    if (dist !== undefined && (!best || dist < best.dist)) best = { target: p, dist };
  }
  return best;
}

export function meleeBoulderTarget(ctx: Ctx, zoneId: string, cx: number, cy: number, aim: { dirX: number; dirY: number }) {
  let best: { target: NonNullable<ReturnType<typeof boulderAt>>; dist: number } | undefined;
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) {
    const dist = meleeHit(cx, cy, aim.dirX, aim.dirY, { x: b.x + 0.5, y: b.y + 0.5, radius: BOULDER_HIT_RADIUS });
    if (dist !== undefined && (!best || dist < best.dist)) best = { target: b, dist };
  }
  return best;
}

export function meleeTreeTarget(ctx: Ctx, zoneId: string, cx: number, cy: number, aim: { dirX: number; dirY: number }) {
  let best: { target: NonNullable<ReturnType<typeof treeAt>>; dist: number } | undefined;
  for (const tr of ctx.db.tree.zoneId.filter(zoneId)) {
    const dist = meleeHit(cx, cy, aim.dirX, aim.dirY, { x: tr.x + 0.5, y: tr.y + 0.5, radius: TREE_HIT_RADIUS });
    if (dist !== undefined && (!best || dist < best.dist)) best = { target: tr, dist };
  }
  return best;
}

/**
 * Drop a carried entity (GDD "Interacting") onto the faced tile, or the nearest
 * free neighbour, then the trogg's own tile (`spawnTile`) — so a boulder never
 * lands in a wall or on another boulder. Returns false if every candidate is
 * blocked, leaving the trogg still carrying it. `x`/`y` are the trogg's settled
 * tile; `dirX`/`dirY` its facing (0,0 = no faced tile, take a neighbour).
 */
export function placeCarried(
  ctx: Ctx,
  zone: Zone,
  kind: string,
  style: string,
  occupied: Set<string>,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
): boolean {
  const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), x, y, dirX, dirY);
  if (!tile) return false;
  return placeCarriedAt(ctx, zone, kind, style, tile);
}

/** Materialise a carried entity on an exact tile, enforcing the same caps as
 *  put-down. `landingAt` keeps a thrown carryable at rest until it touches down;
 *  the default (epoch) is a grounded put-down. */
export function placeCarriedAt(ctx: Ctx, zone: Zone, kind: string, style: string, tile: { x: number; y: number }, landingAt: Timestamp = Timestamp.UNIX_EPOCH): boolean {
  // Honour the per-zone cap on the put-down too, so picking up, spawning to the cap, then
  // dropping can't push a zone past its ceiling. Refusing keeps the trogg carrying — the
  // same outcome as a boxed-in drop — so nothing is lost.
  if (kind === "boulder") {
    if (countRows(ctx.db.boulder.zoneId.filter(zone.slug)) >= MAX_BOULDERS_PER_ZONE) return false;
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y, health: BOULDER_MAX_HEALTH, cellId: 0 });
  } else {
    return false;
  }
  return true;
}

/** The direction a trogg visually faces: current motion while moving, standing facing otherwise. */
export function facingDir(p: { dirX: number; dirY: number; faceX: number; faceY: number }): { dirX: number; dirY: number } {
  if (p.dirX !== 0 || p.dirY !== 0) return { dirX: p.dirX, dirY: p.dirY };
  return { dirX: p.faceX, dirY: p.faceY };
}

/** Coerce an untrusted axis input to -1, 0, or 1. */
export function unitStep(value: number): number {
  return value === -1 || value === 1 ? value : 0;
}

/**
 * Resolve an untrusted (dirX, dirY) to a movement heading: an integer vector with
 * each axis clamped to [-DIR_SCALE, DIR_SCALE]. Movement is free-direction
 * (camera-relative headings quantise to this wire scale); only the vector's
 * direction matters — the shared projection normalises, so magnitude never buys
 * speed. (0, 0) = idle.
 */
export function directionVector(dirX: number, dirY: number): { dirX: number; dirY: number } {
  const axis = (v: number) => (Number.isFinite(v) ? Math.max(-DIR_SCALE, Math.min(DIR_SCALE, Math.trunc(v))) : 0);
  return { dirX: axis(dirX), dirY: axis(dirY) };
}

/**
 * Resolve an untrusted (dirX, dirY) to a cardinal: idle, or one axis of unit
 * length. Facing (and the tile mechanics that hang off it) stays cardinal; a
 * diagonal returns null so the caller can reject it.
 */
export function cardinal(dirX: number, dirY: number): { dirX: number; dirY: number } | null {
  const x = unitStep(dirX);
  const y = unitStep(dirY);
  if (x !== 0 && y !== 0) return null;
  return { dirX: x, dirY: y };
}
