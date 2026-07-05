import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  blockFractionOf,
  elapsedMs,
  EMERGE_ARRIVAL,
  getZone,
  type LootRoll,
  isWalkable,
  STARTING_ZONE_SLUG,
  MAX_GROUND_ITEMS_PER_ZONE,
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
  settle,
  solidTiles,
  addGroundItemTiles,
  countRows,
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
  // Always respawn just outside your cave: the coast alcove in the world, where
  // you first emerged and where you descend back down (GDD "Onboarding"). A
  // trogg that died inside its birth cave is pulled out here too — the cave is
  // for births, not a spawn room — which reads as a zone transfer to the client.
  ctx.db.player.identity.update({
    ...current,
    zoneId: STARTING_ZONE_SLUG,
    x: EMERGE_ARRIVAL.x,
    y: EMERGE_ARRIVAL.y,
    z: 0,
    dirZ: 0,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    faceX: 0,
    faceY: -1, // facing out from the cave mouth, toward the world
    health: PLAYER_MAX_HEALTH,
    dead: false,
    respawnAt: undefined,
    movedAt: ctx.timestamp,
  });
}

/** `dealt` is the damage actually applied after any reduction (a shield's
 *  block), which callers report to analytics instead of the raw weapon roll. */
type DamageResult = { health: number; killed: boolean; dealt: number };
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

/** Lay creature loot near its corpse, capped by the zone's ground-item limit. */
export function dropLoot(ctx: Ctx, zoneId: string, loot: readonly LootRoll[], at: { x: number; y: number }): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  const occupied = solidTiles(ctx, zoneId, ctx.timestamp);
  addGroundItemTiles(ctx, zoneId, occupied);
  for (const roll of loot) {
    if (countRows(ctx.db.groundItem.zoneId.filter(zoneId)) >= MAX_GROUND_ITEMS_PER_ZONE) return;
    const qty = ctx.random.integerInRange(roll.min, roll.max);
    if (qty <= 0) continue;
    const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), at.x, at.y, 0, 0);
    if (!tile) return;
    occupied.add(tileKey(tile.x, tile.y));
    ctx.db.groundItem.insert({ id: 0n, zoneId, item: roll.item, x: tile.x, y: tile.y, qty });
  }
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

/** Apply weapon damage to a trogg; zero health kills, drops inventory, and starts respawn.
 *  A shield equipped in the off hand blocks `SHIELD_BLOCK_FRACTION` of the raw amount first
 *  (GDD "Combat"), so `dealt` on the result can read lower than `amount`. */
export function damagePlayer(ctx: Ctx, target: NonNullable<ReturnType<typeof playerAt>>, amount: number): PlayerDamageResult {
  // the invulnerability cheat (GDD "Commands panel"): the swing lands, nothing changes
  if (target.cheatInvulnerable) return { health: target.health, killed: false, dealt: 0, droppedItemRows: 0, droppedItemQty: 0, respawnMs: 0 };
  const dealt = Math.round(amount * (1 - blockFractionOf(target.equippedOffHand)));
  const health = Math.max(0, target.health - dealt);
  if (health > 0) {
    ctx.db.player.identity.update({ ...target, health, lastDamagedAt: ctx.timestamp });
    return { health, killed: false, dealt, droppedItemRows: 0, droppedItemQty: 0, respawnMs: 0 };
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
    z: 0,
    dirZ: 0,
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
  return { health: 0, killed: true, dealt, droppedItemRows: dropped.rows, droppedItemQty: dropped.qty, respawnMs: PLAYER_RESPAWN_MS };
}

/** Throw a legacy carried boulder along the exact aim. */
export function throwCarried(
  ctx: Ctx,
  p: NonNullable<ReturnType<typeof playerAt>>,
  zone: Zone,
  pos: { x: number; y: number },
  aim: { dirX: number; dirY: number },
):
  | {
      kind: "boulder";
      range: number;
      hitTarget?: "trogg";
      damage?: number;
      killed: boolean;
      playerDeath?: PlayerDamageResult & { distinctId: string };
    }
  | undefined {
  if (p.carrying !== "boulder") return undefined;

  const len = Math.hypot(aim.dirX, aim.dirY);
  if (len === 0) return undefined;
  const ux = aim.dirX / len;
  const uy = aim.dirY / len;

  const sx = Math.round(pos.x);
  const sy = Math.round(pos.y);
  const pathOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
  let lastFree: { x: number; y: number } | undefined;
  let hit: NonNullable<ReturnType<typeof playerAt>> | undefined;

  // Walk the aim ray tile by tile out to range: sample every half tile and act
  // on each new tile the ray enters, so a diagonal throw travels diagonally
  // instead of snapping to an axis.
  let prevKey = tileKey(sx, sy);
  for (let d = 0.5; d <= THROWN_OBJECT_RANGE + 1e-6; d += 0.5) {
    const tx = Math.round(sx + ux * d);
    const ty = Math.round(sy + uy * d);
    const key = tileKey(tx, ty);
    if (key === prevKey) continue;
    prevKey = key;
    if (!isWalkable(zone, tx, ty)) break;

    hit = playerAt(ctx, p.zoneId, tx, ty, ctx.timestamp, p.identity);
    if (hit) break;
    if (pathOccupied.has(key)) break;
    lastFree = { x: tx, y: ty };
  }

  let landing = lastFree;
  if (hit) {
    const targetTile = snapToTile(settle(ctx, hit, ctx.timestamp));
    const landingOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp);
    landing = spawnTile(zone, (tx, ty) => landingOccupied.has(tileKey(tx, ty)), targetTile.x, targetTile.y, ux, uy) ?? lastFree;
  }

  const dist = landing ? Math.hypot(landing.x - sx, landing.y - sy) : 0;
  if (!landing || !placeCarriedAt(ctx, zone, p.carrying, p.carryingStyle, landing)) return undefined;
  const range = Math.round(dist);
  const result: {
    kind: "boulder";
    range: number;
    hitTarget?: "trogg";
    damage?: number;
    killed: boolean;
    playerDeath?: PlayerDamageResult & { distinctId: string };
  } = { kind: p.carrying, range, killed: false };
  if (hit) {
    const damage = damagePlayer(ctx, hit, THROWN_OBJECT_DAMAGE);
    result.hitTarget = "trogg";
    result.damage = damage.dealt;
    result.killed = damage.killed;
    if (damage.killed) result.playerDeath = { ...damage, distinctId: hit.identity.toHexString() };
  }
  ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
  return result;
}
