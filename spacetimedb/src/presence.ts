import { ScheduleAt } from "spacetimedb";
import {
  EMBER_NODE_DAMAGE,
  EMBER_WANDER_INTERVAL_MS,
  derivedKindlingCharge,
  findPath,
  getZone,
  isTileLit,
  isWalkable,
  nearestSafeTile,
  serializePath,
  tileKey,
  zoneBounds,
} from "../../shared/index";
import type { Ctx } from "./schema";
import { brazierLightTiles } from "./braziers";
import { depositStockpile } from "./stockpile";
import { obstacleTiles, settle } from "./tiles";

type PlayerRow = NonNullable<ReturnType<Ctx["db"]["player"]["identity"]["find"]>>;

function anyoneOnline(ctx: Ctx): boolean {
  for (const player of ctx.db.player.iter()) if (player.online) return true;
  return false;
}

function onlineZones(ctx: Ctx): Set<string> {
  const zones = new Set<string>();
  for (const player of ctx.db.player.iter()) {
    if (player.online) zones.add(player.zoneId);
  }
  return zones;
}

export function recordBrightActivity(ctx: Ctx, player: PlayerRow): PlayerRow {
  if (!player.online) return player;
  const charge = derivedKindlingCharge(player, ctx.timestamp);
  const next = { ...player, kindlingCharge: charge, kindlingChargeAt: ctx.timestamp };
  if (charge !== player.kindlingCharge || player.kindlingChargeAt.microsSinceUnixEpoch !== ctx.timestamp.microsSinceUnixEpoch) {
    ctx.db.player.identity.update(next);
  }
  return next;
}

export function settleKindling(player: PlayerRow, now: PlayerRow["kindlingChargeAt"], online: boolean): PlayerRow {
  return {
    ...player,
    online,
    kindlingCharge: derivedKindlingCharge(player, now),
    kindlingChargeAt: now,
  };
}

function nearestHearth(ctx: Ctx, zoneId: string, x: number, y: number): { x: number; y: number } | undefined {
  const zone = getZone(zoneId);
  if (!zone) return undefined;
  const hearths = [...ctx.db.brazier.zoneId.filter(zoneId)]
    .filter((row) => row.lit)
    .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  for (const hearth of hearths) {
    const tile = nearestSafeTile(zone, hearth.x, hearth.y);
    if (tile) return tile;
  }
  return zone.spawn;
}

export function recallToLight(ctx: Ctx, player: PlayerRow, x: number, y: number): { x: number; y: number } {
  const sources = ctx.db.brazier.zoneId.filter(player.zoneId);
  if (isTileLit(sources, player.zoneId, Math.round(x), Math.round(y))) return { x, y };
  return nearestHearth(ctx, player.zoneId, x, y) ?? { x, y };
}

export function armEmberWander(ctx: Ctx): void {
  if (ctx.db.emberWander.count() > 0n || !anyoneOnline(ctx)) return;
  const zones = onlineZones(ctx);
  const active =
    [...ctx.db.player.iter()].some((player) => !player.online && zones.has(player.zoneId) && derivedKindlingCharge(player, ctx.timestamp) > 0) ||
    [...ctx.db.darkCreature.iter()].some((creature) => creature.health > 0 && zones.has(creature.zoneId));
  if (!active) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(EMBER_WANDER_INTERVAL_MS) * 1000n;
  ctx.db.emberWander.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

function nearestInteriorNode(ctx: Ctx, player: PlayerRow, x: number, y: number) {
  const lit = brazierLightTiles(ctx, player.zoneId);
  const candidates = [
    ...[...ctx.db.boulder.zoneId.filter(player.zoneId)].map((row) => ({ kind: "boulder" as const, row })),
    ...[...ctx.db.tree.zoneId.filter(player.zoneId)].map((row) => ({ kind: "tree" as const, row })),
  ].filter(({ row }) => lit.has(tileKey(row.x, row.y)));
  return candidates.sort((a, b) => Math.hypot(a.row.x - x, a.row.y - y) - Math.hypot(b.row.x - x, b.row.y - y))[0];
}

function workNode(ctx: Ctx, player: PlayerRow, target: NonNullable<ReturnType<typeof nearestInteriorNode>>): void {
  if (target.row.health > EMBER_NODE_DAMAGE) {
    if (target.kind === "boulder") ctx.db.boulder.id.update({ ...target.row, health: target.row.health - EMBER_NODE_DAMAGE });
    else ctx.db.tree.id.update({ ...target.row, health: target.row.health - EMBER_NODE_DAMAGE });
    return;
  }
  if (target.kind === "boulder") {
    ctx.db.boulder.id.delete(target.row.id);
    depositStockpile(ctx, player.identity, "stone", 1);
  } else {
    ctx.db.tree.id.delete(target.row.id);
    depositStockpile(ctx, player.identity, "wood", 1);
  }
}

function stepTowardNode(ctx: Ctx, player: PlayerRow, x: number, y: number, target: NonNullable<ReturnType<typeof nearestInteriorNode>>): void {
  const zone = getZone(player.zoneId);
  if (!zone) return;
  const lit = brazierLightTiles(ctx, player.zoneId);
  const obstacles = obstacleTiles(ctx, player.zoneId);
  obstacles.delete(tileKey(target.row.x, target.row.y));
  const bounds = zoneBounds(zone, (tx, ty) => !lit.has(tileKey(tx, ty)) || obstacles.has(tileKey(tx, ty)));
  const path = findPath(bounds, { x, y }, { x: target.row.x, y: target.row.y });
  const next = path[0];
  if (!next || !isWalkable(zone, next.x, next.y)) return;
  const dirX = Math.sign(next.x - x);
  const dirY = Math.sign(next.y - y);
  ctx.db.player.identity.update({
    ...player,
    x,
    y,
    dirX,
    dirY,
    faceX: Math.abs(dirX) >= Math.abs(dirY) ? dirX : 0,
    faceY: Math.abs(dirX) >= Math.abs(dirY) ? 0 : dirY,
    path: serializePath([next]),
    running: false,
    movedAt: ctx.timestamp,
  });
}

export function runEmberWork(ctx: Ctx): void {
  if (!anyoneOnline(ctx)) return;
  const zones = onlineZones(ctx);
  for (const player of [...ctx.db.player.iter()]) {
    if (player.online) continue;
    if (!zones.has(player.zoneId)) continue;
    const charge = derivedKindlingCharge(player, ctx.timestamp);
    const settled = settle(ctx, player, ctx.timestamp);
    if (charge <= 0) {
      const at = nearestHearth(ctx, player.zoneId, settled.x, settled.y) ?? { x: settled.x, y: settled.y };
      ctx.db.player.identity.update({
        ...player,
        x: at.x,
        y: at.y,
        dirX: 0,
        dirY: 0,
        path: "",
        running: false,
        kindlingCharge: 0,
        kindlingChargeAt: ctx.timestamp,
        movedAt: ctx.timestamp,
      });
      continue;
    }

    const safe = recallToLight(ctx, player, settled.x, settled.y);
    const current = safe.x === settled.x && safe.y === settled.y
      ? player
      : { ...player, x: safe.x, y: safe.y, dirX: 0, dirY: 0, path: "", running: false, movedAt: ctx.timestamp };
    if (current !== player) ctx.db.player.identity.update(current);
    const target = nearestInteriorNode(ctx, current, safe.x, safe.y);
    if (!target) continue;
    if (Math.hypot(target.row.x - safe.x, target.row.y - safe.y) <= 1.5) workNode(ctx, current, target);
    else stepTowardNode(ctx, current, safe.x, safe.y, target);
  }
}
