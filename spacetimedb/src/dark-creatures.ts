import { Timestamp } from "spacetimedb";
import {
  DARK_CREATURE_AGGRO_RANGE,
  DARK_CREATURE_ATTACK_COOLDOWN_MS,
  DARK_CREATURE_ATTACK_RANGE,
  DARK_CREATURE_DAMAGE,
  DARK_CREATURE_IDLE_CHANCE,
  DARK_CREATURE_MAX_HEALTH,
  DARK_CREATURE_TURN_CHANCE,
  MAX_DARK_CREATURES_PER_ZONE,
  elapsedMs,
  findPath,
  getZone,
  isDryFloor,
  projectMotion,
  serializePath,
  tileKey,
  walkableSteps,
  worldRingAt,
  worldRingSeed,
  zoneBounds,
} from "../../shared/index";
import type { Ctx } from "./schema";
import { damagePlayer } from "./combat";
import { brazierLightTiles } from "./braziers";
import { generatedTile, obstacleTiles, settle } from "./tiles";

type DarkCreatureRow = ReturnType<Ctx["db"]["darkCreature"]["iter"]> extends Iterable<infer Row> ? Row : never;

function onlineZones(ctx: Ctx): Set<string> {
  const zones = new Set<string>();
  for (const player of ctx.db.player.iter()) {
    if (player.online) zones.add(player.zoneId);
  }
  return zones;
}

export function seedDarkCreatureRing(ctx: Ctx, zoneId: string, ring: number): void {
  const zone = getZone(zoneId);
  const origin = zone?.spawn;
  if (!zone || !origin) return;
  const remaining = Math.max(0, MAX_DARK_CREATURES_PER_ZONE - [...ctx.db.darkCreature.zoneId.filter(zoneId)].length);
  if (remaining === 0) return;
  const lit = brazierLightTiles(ctx, zoneId);
  const obstacles = obstacleTiles(ctx, zoneId);
  const seed = worldRingSeed(ring);
  let inserted = 0;
  const limit = Math.min(12, remaining);
  for (let y = 1; y < zone.height - 1 && inserted < limit; y++) {
    for (let x = 1; x < zone.width - 1 && inserted < limit; x++) {
      const hash = (Math.imul(x + 17, 73_856_093) ^ Math.imul(y + 31, 19_349_663) ^ seed) >>> 0;
      if (worldRingAt(origin, x, y) !== ring || hash % 997 >= 5 || !isDryFloor(zone, x, y) || lit.has(tileKey(x, y)) || obstacles.has(tileKey(x, y))) continue;
      ctx.db.darkCreature.insert({
        id: 0n,
        zoneId,
        x,
        y,
        dirX: 0,
        dirY: 0,
        movedAt: ctx.timestamp,
        path: "",
        species: "gloam",
        health: DARK_CREATURE_MAX_HEALTH,
        lastDamagedAt: Timestamp.UNIX_EPOCH,
        aggroTargetId: "",
        lastAttackAt: Timestamp.UNIX_EPOCH,
      });
      inserted++;
    }
  }
}

function projectedCreature(ctx: Ctx, creature: DarkCreatureRow, occupied: Set<string>) {
  const zone = getZone(creature.zoneId);
  if (!zone) return { x: creature.x, y: creature.y };
  const lit = brazierLightTiles(ctx, creature.zoneId);
  const own = tileKey(Math.round(creature.x), Math.round(creature.y));
  const bounds = zoneBounds(zone, (x, y) => {
    const key = tileKey(x, y);
    return !generatedTile(ctx, creature.zoneId, x, y) || lit.has(key) || (key !== own && occupied.has(key));
  });
  return projectMotion({ ...creature, running: false }, elapsedMs(creature.movedAt, ctx.timestamp), bounds);
}

function brightTargets(ctx: Ctx, zoneId: string) {
  return [...ctx.db.player.zoneId.filter(zoneId)].filter((player) => player.online && !player.dead);
}

function chooseTarget(ctx: Ctx, creature: DarkCreatureRow, x: number, y: number) {
  let best: { player: ReturnType<typeof brightTargets>[number]; x: number; y: number; distance: number } | undefined;
  for (const player of brightTargets(ctx, creature.zoneId)) {
    const pos = settle(ctx, player, ctx.timestamp);
    const distance = Math.hypot(pos.x - x, pos.y - y);
    if (distance <= DARK_CREATURE_AGGRO_RANGE && (!best || distance < best.distance)) {
      best = { player, x: pos.x, y: pos.y, distance };
    }
  }
  return best;
}

function nextHeading(ctx: Ctx, creature: DarkCreatureRow, x: number, y: number, occupied: Set<string>, target?: ReturnType<typeof chooseTarget>) {
  const zone = getZone(creature.zoneId);
  if (!zone) return { dirX: 0, dirY: 0, path: "" };
  const lit = brazierLightTiles(ctx, creature.zoneId);
  const own = tileKey(Math.round(x), Math.round(y));
  const bounds = zoneBounds(zone, (tx, ty) => {
    const key = tileKey(tx, ty);
    return !generatedTile(ctx, creature.zoneId, tx, ty) || lit.has(key) || (key !== own && occupied.has(key));
  });
  if (target) {
    const path = findPath(bounds, { x, y }, { x: Math.round(target.x), y: Math.round(target.y) });
    const next = path[0];
    if (next) {
      return {
        dirX: Math.sign(next.x - x),
        dirY: Math.sign(next.y - y),
        path: serializePath([next]),
      };
    }
  }
  if (ctx.random() < DARK_CREATURE_IDLE_CHANCE) return { dirX: 0, dirY: 0, path: "" };
  const options = walkableSteps(bounds, Math.round(x), Math.round(y), 1);
  const step = options.length > 0 ? options[ctx.random.integerInRange(0, options.length - 1)] : undefined;
  return step ? { dirX: step.dirX, dirY: step.dirY, path: serializePath([{ x: Math.round(x) + step.dirX, y: Math.round(y) + step.dirY }]) } : { dirX: 0, dirY: 0, path: "" };
}

export function runDarkCreatures(ctx: Ctx): void {
  const creatures = [...ctx.db.darkCreature.iter()];
  const zones = onlineZones(ctx);
  const occupiedByZone = new Map<string, Set<string>>();
  for (const creature of creatures) {
    if (!zones.has(creature.zoneId)) continue;
    if (creature.health <= 0) continue;
    let occupied = occupiedByZone.get(creature.zoneId);
    if (!occupied) {
      occupied = obstacleTiles(ctx, creature.zoneId);
      occupiedByZone.set(creature.zoneId, occupied);
    }
    occupied.add(tileKey(Math.round(creature.x), Math.round(creature.y)));
  }

  for (const creature of creatures) {
    if (!zones.has(creature.zoneId)) continue;
    if (creature.health <= 0) continue;
    const occupied = occupiedByZone.get(creature.zoneId) ?? new Set<string>();
    const pos = projectedCreature(ctx, creature, occupied);
    occupied.delete(tileKey(Math.round(creature.x), Math.round(creature.y)));
    occupied.add(tileKey(Math.round(pos.x), Math.round(pos.y)));
    const target = chooseTarget(ctx, creature, pos.x, pos.y);
    const lit = brazierLightTiles(ctx, creature.zoneId);
    const targetLit = target ? lit.has(tileKey(Math.round(target.x), Math.round(target.y))) : false;
    if (
      target &&
      !targetLit &&
      target.distance <= DARK_CREATURE_ATTACK_RANGE &&
      elapsedMs(creature.lastAttackAt, ctx.timestamp) >= DARK_CREATURE_ATTACK_COOLDOWN_MS
    ) {
      const damage = ctx.random.integerInRange(DARK_CREATURE_DAMAGE[0], DARK_CREATURE_DAMAGE[1]);
      damagePlayer(ctx, target.player, damage);
      ctx.db.darkCreature.id.update({
        ...creature,
        x: pos.x,
        y: pos.y,
        dirX: 0,
        dirY: 0,
        path: "",
        movedAt: ctx.timestamp,
        aggroTargetId: target.player.identity.toHexString(),
        lastAttackAt: ctx.timestamp,
      });
      continue;
    }

    const moving = creature.dirX !== 0 || creature.dirY !== 0;
    const keepHeading = !target && moving && ctx.random() > DARK_CREATURE_TURN_CHANCE;
    const heading = keepHeading
      ? { dirX: creature.dirX, dirY: creature.dirY, path: creature.path }
      : nextHeading(ctx, creature, pos.x, pos.y, occupied, target);
    const aggroTargetId = target?.player.identity.toHexString() ?? "";
    const unchanged =
      pos.x === creature.x &&
      pos.y === creature.y &&
      heading.dirX === creature.dirX &&
      heading.dirY === creature.dirY &&
      heading.path === creature.path &&
      aggroTargetId === creature.aggroTargetId;
    if (unchanged) continue;
    ctx.db.darkCreature.id.update({
      ...creature,
      x: pos.x,
      y: pos.y,
      dirX: heading.dirX,
      dirY: heading.dirY,
      path: heading.path,
      movedAt: ctx.timestamp,
      aggroTargetId,
    });
  }
}

export function resetDarkCreatures(ctx: Ctx, zoneId: string): void {
  for (const creature of [...ctx.db.darkCreature.zoneId.filter(zoneId)]) ctx.db.darkCreature.id.delete(creature.id);
  for (const row of ctx.db.worldRing.iter()) seedDarkCreatureRing(ctx, zoneId, row.ring);
}
