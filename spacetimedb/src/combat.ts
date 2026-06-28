import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  elapsedMs,
  getZone,
  isWalkable,
  HOG_MAX_HEALTH,
  PLAYER_MAX_HEALTH,
  PLAYER_RESPAWN_MS,
  snapToTile,
  spawnTile,
  spawnTiles,
  THROWN_OBJECT_DAMAGE,
  THROWN_OBJECT_RANGE,
  type Stamp,
  tileKey,
  type Zone,
} from "../../shared/index";
import {
  spawnAt,
  settle,
  solidTiles,
  hogAt,
  hogTile,
  playerAt,
  placeCarried,
  placeCarriedAt,
  facingDir,
} from "./tiles";
import type { Ctx, AnalyticsEvent } from "./schema";

export function addMs(timestamp: Stamp, ms: number): Timestamp {
  return new Timestamp(timestamp.microsSinceUnixEpoch + BigInt(Math.round(ms)) * 1000n);
}

export function scheduleRespawnAt(ctx: Ctx, playerId: Ctx["sender"], at: Stamp): void {
  ctx.db.playerRespawn.insert({ scheduledId: 0n, playerId, scheduledAt: ScheduleAt.time(at.microsSinceUnixEpoch) });
}

export function respawnDue(p: { respawnAt?: Stamp }, now: Stamp): boolean {
  return !!p.respawnAt && elapsedMs(p.respawnAt, now) >= 0;
}

export function respawnPlayer(ctx: Ctx, p: { identity: Ctx["sender"]; zoneId: string }): void {
  const current = ctx.db.player.identity.find(p.identity);
  if (!current || !current.dead) return;
  const zone = getZone(current.zoneId);
  if (!zone) return;
  const at = spawnAt(zone);
  ctx.db.player.identity.update({
    ...current,
    x: at.x,
    y: at.y,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    health: PLAYER_MAX_HEALTH,
    dead: false,
    respawnAt: undefined,
    movedAt: ctx.timestamp,
  });
}

type DamageResult = { health: number; killed: boolean };
type PlayerDamageResult = DamageResult & { droppedItemRows: number; droppedItemQty: number; respawnMs: number };

export function playerDiedEvent(distinctId: string, props: Record<string, string | number | boolean>, cause: string, result: PlayerDamageResult): AnalyticsEvent {
  return {
    distinctId,
    event: "player_died",
    properties: {
      ...props,
      cause,
      dropped_item_rows: result.droppedItemRows,
      dropped_item_qty: result.droppedItemQty,
      respawn_ms: result.respawnMs,
    },
  };
}

export function hogHealth(h: { health?: number }): number {
  return typeof h.health === "number" ? h.health : HOG_MAX_HEALTH;
}

export function damageHog(ctx: Ctx, target: NonNullable<ReturnType<typeof hogAt>>, amount: number): DamageResult {
  const health = Math.max(0, hogHealth(target) - amount);
  if (health > 0) {
    ctx.db.hog.id.update({ ...target, health });
    return { health, killed: false };
  }
  ctx.db.hog.id.delete(target.id);
  return { health: 0, killed: true };
}

export function dropInventory(ctx: Ctx, target: NonNullable<ReturnType<typeof playerAt>>, x: number, y: number): { rows: number; qty: number } {
  const zone = getZone(target.zoneId);
  if (!zone) return { rows: 0, qty: 0 };
  const rows = [...ctx.db.inventory.playerId.filter(target.identity)].filter((row) => row.qty > 0);
  if (rows.length === 0) return { rows: 0, qty: 0 };

  const occupied = solidTiles(ctx, target.zoneId, ctx.timestamp, target.identity);
  const face = facingDir(target);
  const tiles = spawnTiles(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), x, y, face.dirX, face.dirY, rows.length);
  let qty = 0;
  rows.forEach((row, i) => {
    const tile = tiles[i] ?? { x, y };
    occupied.add(tileKey(tile.x, tile.y));
    ctx.db.groundItem.insert({ id: 0n, zoneId: target.zoneId, item: row.item, x: tile.x, y: tile.y, qty: row.qty });
    qty += row.qty;
    ctx.db.inventory.id.delete(row.id);
  });
  return { rows: rows.length, qty };
}

/** Apply weapon damage to a trogg; zero health kills, drops inventory, and starts respawn. */
export function damagePlayer(ctx: Ctx, target: NonNullable<ReturnType<typeof playerAt>>, amount: number): PlayerDamageResult {
  const health = Math.max(0, target.health - amount);
  if (health > 0) {
    ctx.db.player.identity.update({ ...target, health });
    return { health, killed: false, droppedItemRows: 0, droppedItemQty: 0, respawnMs: 0 };
  }

  const settled = settle(ctx, target, ctx.timestamp);
  let carrying = target.carrying;
  let carryingStyle = target.carryingStyle;
  if (carrying !== "") {
    const zone = getZone(target.zoneId);
    const occupied = solidTiles(ctx, target.zoneId, ctx.timestamp, target.identity);
    const face = facingDir(target);
    if (zone && placeCarried(ctx, zone, carrying, carryingStyle, occupied, settled.x, settled.y, face.dirX, face.dirY)) {
      carrying = "";
      carryingStyle = "";
    }
  }
  const dropped = dropInventory(ctx, target, settled.x, settled.y);
  const respawnAt = addMs(ctx.timestamp, PLAYER_RESPAWN_MS);
  scheduleRespawnAt(ctx, target.identity, respawnAt);

  ctx.db.player.identity.update({
    ...target,
    x: settled.x,
    y: settled.y,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    carrying,
    carryingStyle,
    equippedMainHand: "",
    equippedMainHandInventoryId: 0n,
    health: 0,
    dead: true,
    respawnAt,
    movedAt: ctx.timestamp,
  });
  return { health: 0, killed: true, droppedItemRows: dropped.rows, droppedItemQty: dropped.qty, respawnMs: PLAYER_RESPAWN_MS };
}

/** Throw a carried boulder or Hog in a straight cardinal line, damaging the first character hit. */
export function throwCarried(
  ctx: Ctx,
  p: NonNullable<ReturnType<typeof playerAt>>,
  zone: Zone,
  pos: { x: number; y: number },
  dir: { dirX: number; dirY: number },
):
  | {
      kind: "boulder" | "hog";
      range: number;
      hitTarget?: "trogg" | "hog";
      damage?: number;
      killed: boolean;
      playerDeath?: PlayerDamageResult & { distinctId: string };
    }
  | undefined {
  if (p.carrying !== "boulder" && p.carrying !== "hog") return undefined;

  const sx = Math.round(pos.x);
  const sy = Math.round(pos.y);
  const pathOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  let lastFree: { x: number; y: number } | undefined;
  let hit: NonNullable<ReturnType<typeof playerAt>> | undefined;
  let hogHit: NonNullable<ReturnType<typeof hogAt>> | undefined;

  for (let step = 1; step <= THROWN_OBJECT_RANGE; step++) {
    const tx = sx + dir.dirX * step;
    const ty = sy + dir.dirY * step;
    if (!isWalkable(zone, tx, ty)) break;

    hit = playerAt(ctx, p.zoneId, tx, ty, ctx.timestamp, p.identity);
    if (hit) break;
    hogHit = hogAt(ctx, p.zoneId, tx, ty, ctx.timestamp);
    if (hogHit) break;

    if (pathOccupied.has(tileKey(tx, ty))) break;
    lastFree = { x: tx, y: ty };
  }

  let landing = lastFree;
  if (hit || hogHit) {
    const targetTile = hit ? snapToTile(settle(ctx, hit, ctx.timestamp)) : hogTile(ctx, hogHit!, ctx.timestamp);
    const landingOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp);
    landing = spawnTile(zone, (tx, ty) => landingOccupied.has(tileKey(tx, ty)), targetTile.x, targetTile.y, dir.dirX, dir.dirY) ?? lastFree;
  }

  if (!landing || !placeCarriedAt(ctx, zone, p.carrying, p.carryingStyle, landing)) return undefined;
  const range = Math.abs(dir.dirX !== 0 ? landing.x - sx : landing.y - sy);
  const result: {
    kind: "boulder" | "hog";
    range: number;
    hitTarget?: "trogg" | "hog";
    damage?: number;
    killed: boolean;
    playerDeath?: PlayerDamageResult & { distinctId: string };
  } = { kind: p.carrying, range, killed: false };
  if (hit) {
    const damage = damagePlayer(ctx, hit, THROWN_OBJECT_DAMAGE);
    result.hitTarget = "trogg";
    result.damage = THROWN_OBJECT_DAMAGE;
    result.killed = damage.killed;
    if (damage.killed) result.playerDeath = { ...damage, distinctId: hit.identity.toHexString() };
  }
  if (hogHit) {
    const damage = damageHog(ctx, hogHit, THROWN_OBJECT_DAMAGE);
    result.hitTarget = "hog";
    result.damage = THROWN_OBJECT_DAMAGE;
    result.killed = damage.killed;
  }
  ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
  return result;
}
