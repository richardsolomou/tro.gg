import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  blockFractionOf,
  elapsedMs,
  EMERGE_ARRIVAL,
  getZone,
  isWalkable,
  STARTING_ZONE_SLUG,
  PLAYER_MAX_HEALTH,
  PLAYER_RESPAWN_MS,
  projectMotion,
  snapToTile,
  spawnTile,
  spawnTiles,
  THROWN_OBJECT_DAMAGE,
  THROWN_OBJECT_RANGE,
  type Stamp,
  tileKey,
  zoneBounds,
  type Zone,
} from "../../shared/index";
import { nearestLitBrazier } from "./brazier";
import {
  settle,
  solidTiles,
  obstacleTiles,
  playerAt,
  darkCreatureAt,
  darkCreatureDef,
  placeCarried,
  placeCarriedAt,
  facingDir,
  revealGate,
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
  // Respawn at the lit brazier nearest the death tile (GDD "Combat") — the
  // fire you fought beside, not a cross-map walk; the First Fire is always
  // lit, so a world death always finds one. A trogg that died inside its
  // birth cave is pulled out to the coast alcove instead — the cave is for
  // births, not a spawn room — which reads as a zone transfer to the client.
  const hearth = current.zoneId === STARTING_ZONE_SLUG ? nearestLitBrazier(ctx, STARTING_ZONE_SLUG, current.x, current.y) : undefined;
  const at = hearth ? { x: hearth.x, y: hearth.y } : EMERGE_ARRIVAL;
  ctx.db.player.identity.update({
    ...current,
    zoneId: STARTING_ZONE_SLUG,
    x: at.x,
    y: at.y,
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

type DarkCreatureDamageResult = DamageResult;

/**
 * Apply weapon damage to a dark creature (GDD "Combat" / "Dark creatures").
 * Zero health settles it as a corpse — stopped, cleared of aggro, at its
 * current (projected) position — and drops its species loot nearby. Whether
 * a fresh one later takes its place is decided at reap time, not here (see
 * the `dark_creature` table doc in schema.ts).
 */
export function damageDarkCreature(ctx: Ctx, target: NonNullable<ReturnType<typeof darkCreatureAt>>, amount: number): DarkCreatureDamageResult {
  const health = Math.max(0, target.health - amount);
  if (health > 0) {
    ctx.db.darkCreature.id.update({ ...target, health, lastDamagedAt: ctx.timestamp });
    return { health, killed: false, dealt: amount };
  }

  const zone = getZone(target.zoneId);
  let x = target.x;
  let y = target.y;
  if (zone) {
    const blockers = obstacleTiles(ctx, target.zoneId);
    const bounds = zoneBounds(zone, (tx, ty) => blockers.has(tileKey(tx, ty)));
    const pos = projectMotion(target, elapsedMs(target.movedAt, ctx.timestamp), bounds);
    x = pos.x;
    y = pos.y;
  }
  ctx.db.darkCreature.id.update({ ...target, x, y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, health: 0, lastDamagedAt: ctx.timestamp, aggroTargetId: "" });

  if (zone) {
    const def = darkCreatureDef(target.species);
    const qty = ctx.random.integerInRange(def.loot.qty[0], def.loot.qty[1]);
    const occupied = solidTiles(ctx, target.zoneId, ctx.timestamp);
    const gate = revealGate(ctx, zone);
    const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)) || gate(tx, ty), Math.round(x), Math.round(y), 0, 0);
    if (tile) ctx.db.groundItem.insert({ id: 0n, zoneId: target.zoneId, item: def.loot.item, x: tile.x, y: tile.y, qty });
  }
  return { health: 0, killed: true, dealt: amount };
}

/** Throw a carried boulder along the exact aim (free-direction, not the four
 *  cardinals), damaging the first trogg hit and landing on the tile the throw
 *  reaches. */
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
      hitTarget?: "trogg" | "dark_creature";
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
  const gate = revealGate(ctx, zone);
  let lastFree: { x: number; y: number } | undefined;
  let hit: NonNullable<ReturnType<typeof playerAt>> | undefined;
  let hitCreature: NonNullable<ReturnType<typeof darkCreatureAt>> | undefined;
  let hitTile: { x: number; y: number } | undefined;

  // Walk the aim ray tile by tile out to range: sample every half tile and act
  // on each new tile the ray enters, so a diagonal throw travels diagonally
  // instead of snapping to an axis. A dark creature outranks a trogg at the
  // same tile, the same priority a melee swing gives it (GDD "Combat").
  let prevKey = tileKey(sx, sy);
  for (let d = 0.5; d <= THROWN_OBJECT_RANGE + 1e-6; d += 0.5) {
    const tx = Math.round(sx + ux * d);
    const ty = Math.round(sy + uy * d);
    const key = tileKey(tx, ty);
    if (key === prevKey) continue;
    prevKey = key;
    if (!isWalkable(zone, tx, ty) || gate(tx, ty)) break;

    hitCreature = darkCreatureAt(ctx, p.zoneId, tx, ty, ctx.timestamp);
    if (!hitCreature) hit = playerAt(ctx, p.zoneId, tx, ty, ctx.timestamp, p.identity);
    if (hitCreature || hit) {
      hitTile = { x: tx, y: ty };
      break;
    }

    if (pathOccupied.has(key)) break;
    lastFree = { x: tx, y: ty };
  }

  let landing = lastFree;
  if (hitCreature) {
    const landingOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp);
    landing = spawnTile(zone, (tx, ty) => landingOccupied.has(tileKey(tx, ty)) || gate(tx, ty), hitTile!.x, hitTile!.y, ux, uy) ?? lastFree;
  } else if (hit) {
    const targetTile = snapToTile(settle(ctx, hit, ctx.timestamp));
    const landingOccupied = solidTiles(ctx, p.zoneId, ctx.timestamp);
    landing = spawnTile(zone, (tx, ty) => landingOccupied.has(tileKey(tx, ty)) || gate(tx, ty), targetTile.x, targetTile.y, ux, uy) ?? lastFree;
  }

  const dist = landing ? Math.hypot(landing.x - sx, landing.y - sy) : 0;
  if (!landing || !placeCarriedAt(ctx, zone, p.carrying, p.carryingStyle, landing)) return undefined;
  const range = Math.round(dist);
  const result: {
    kind: "boulder";
    range: number;
    hitTarget?: "trogg" | "dark_creature";
    damage?: number;
    killed: boolean;
    playerDeath?: PlayerDamageResult & { distinctId: string };
  } = { kind: p.carrying, range, killed: false };
  if (hitCreature) {
    const damage = damageDarkCreature(ctx, hitCreature, THROWN_OBJECT_DAMAGE);
    result.hitTarget = "dark_creature";
    result.damage = damage.dealt;
    result.killed = damage.killed;
  } else if (hit) {
    const damage = damagePlayer(ctx, hit, THROWN_OBJECT_DAMAGE);
    result.hitTarget = "trogg";
    result.damage = damage.dealt;
    result.killed = damage.killed;
    if (damage.killed) result.playerDeath = { ...damage, distinctId: hit.identity.toHexString() };
  }
  ctx.db.player.identity.update({ ...p, carrying: "", carryingStyle: "" });
  return result;
}
