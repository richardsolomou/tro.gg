import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  BRAZIER_RADIUS,
  DARK_CREATURE_MAX_HEALTH,
  IGNITION_DEFENSE_RADIUS,
  IGNITION_FUEL_COST,
  IGNITION_RELIGHT_FUEL_COST,
  IGNITION_RELIGHT_WINDOW_MS,
  IGNITION_SITE_MAX_DISTANCE,
  IGNITION_TICK_MS,
  IGNITION_WAVE_COUNT,
  IGNITION_WINDOW_MS,
  MAX_DARK_CREATURES_PER_ZONE,
  STARTING_ZONE_SLUG,
  elapsedMs,
  getZone,
  isDryFloor,
  isTileLit,
  tileKey,
  worldRingAt,
} from "../../shared/index";
import type { Ctx } from "./schema";
import { addMs } from "./combat";
import { armBrazierUpkeep } from "./braziers";
import { consumeStockpileItem } from "./stockpile";
import { obstacleTiles, settle, troggBlockers } from "./tiles";
import { ensureWorldRings } from "./world-rings";

export interface IgnitionStart {
  projectId: bigint;
  slug: string;
  fuel: number;
  relight: boolean;
}

export function beginIgnition(
  ctx: Ctx,
  player: NonNullable<ReturnType<Ctx["db"]["player"]["identity"]["find"]>>,
  x: number,
  y: number,
): IgnitionStart | undefined {
  if (!player.online || player.dead || player.carrying !== "ember_heart") return undefined;
  if (player.zoneId !== STARTING_ZONE_SLUG) return undefined;
  const zone = getZone(player.zoneId);
  if (!zone || !isDryFloor(zone, x, y)) return undefined;
  ensureWorldRings(ctx);
  const origin = zone.spawn;
  const generatedThrough = Math.max(-1, ...[...ctx.db.worldRing.iter()].map((row) => row.ring));
  if (!origin || worldRingAt(origin, x, y) > generatedThrough) return undefined;
  if (troggBlockers(ctx, player.zoneId, ctx.timestamp).has(tileKey(x, y))) return undefined;
  if (isTileLit(ctx.db.brazier.zoneId.filter(player.zoneId), player.zoneId, x, y)) return undefined;
  const active = [...ctx.db.project.zoneId.filter(player.zoneId)].some((row) => row.status === "active");
  if (active) return undefined;
  const nearestLit = [...ctx.db.brazier.zoneId.filter(player.zoneId)]
    .filter((row) => row.lit)
    .reduce((distance, row) => Math.min(distance, Math.hypot(row.x - x, row.y - y)), Infinity);
  if (nearestLit > IGNITION_SITE_MAX_DISTANCE) return undefined;

  const cold = [...ctx.db.brazier.zoneId.filter(player.zoneId)].find((row) => !row.lit && row.x === x && row.y === y);
  const fuel = cold ? IGNITION_RELIGHT_FUEL_COST : IGNITION_FUEL_COST;
  if ((ctx.db.stockpile.item.find("wood")?.qty ?? 0) < fuel) return undefined;
  const duration = cold ? IGNITION_RELIGHT_WINDOW_MS : IGNITION_WINDOW_MS;
  consumeStockpileItem(ctx, "wood", fuel);
  ctx.db.player.identity.update({ ...player, carrying: "", carryingStyle: "" });
  const inserted = ctx.db.project.insert({
    id: 0n,
    slug: `ignition:${player.zoneId}:${x}:${y}`,
    zoneId: player.zoneId,
    x,
    y,
    status: "active",
    requirements: JSON.stringify({ wood: fuel, ember_heart: 1 }),
    contributed: JSON.stringify({ wood: fuel, ember_heart: 1 }),
    startedBy: player.identity,
    startedAt: ctx.timestamp,
    endsAt: addMs(ctx.timestamp, duration),
  });
  spawnIgnitionWave(ctx, inserted);
  armIgnitions(ctx);
  return { projectId: inserted.id, slug: inserted.slug, fuel, relight: !!cold };
}

export function armIgnitions(ctx: Ctx): void {
  if (ctx.db.ignitionEvent.count() > 0n) return;
  if (![...ctx.db.project.iter()].some((row) => row.status === "active")) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(IGNITION_TICK_MS) * 1000n;
  ctx.db.ignitionEvent.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

function spawnIgnitionWave(ctx: Ctx, project: ReturnType<Ctx["db"]["project"]["id"]["find"]> extends infer Row ? NonNullable<Row> : never): void {
  const zone = getZone(project.zoneId);
  if (!zone) return;
  const occupied = obstacleTiles(ctx, project.zoneId);
  let remaining = Math.max(0, MAX_DARK_CREATURES_PER_ZONE - [...ctx.db.darkCreature.zoneId.filter(project.zoneId)].length);
  for (const creature of ctx.db.darkCreature.zoneId.filter(project.zoneId)) {
    if (creature.health > 0) occupied.add(tileKey(Math.round(creature.x), Math.round(creature.y)));
  }
  for (let i = 0; i < IGNITION_WAVE_COUNT && remaining > 0; i++) {
    const offset = ctx.random.integerInRange(0, 7);
    let placed = false;
    for (let step = 0; step < 8 && !placed; step++) {
      const angle = ((offset + step) / 8) * Math.PI * 2;
      const x = Math.round(project.x + Math.cos(angle) * (IGNITION_DEFENSE_RADIUS + 2));
      const y = Math.round(project.y + Math.sin(angle) * (IGNITION_DEFENSE_RADIUS + 2));
      const key = tileKey(x, y);
      if (!isDryFloor(zone, x, y) || occupied.has(key)) continue;
      if (isTileLit(ctx.db.brazier.zoneId.filter(project.zoneId), project.zoneId, x, y)) continue;
      ctx.db.darkCreature.insert({
        id: 0n,
        zoneId: project.zoneId,
        x,
        y,
        dirX: 0,
        dirY: 0,
        movedAt: ctx.timestamp,
        path: "",
        species: "gloam",
        health: DARK_CREATURE_MAX_HEALTH,
        lastDamagedAt: Timestamp.UNIX_EPOCH,
        aggroTargetId: project.startedBy.toHexString(),
        lastAttackAt: Timestamp.UNIX_EPOCH,
      });
      occupied.add(key);
      remaining--;
      placed = true;
    }
  }
}

function ignitionDefended(ctx: Ctx, project: ReturnType<Ctx["db"]["project"]["id"]["find"]> extends infer Row ? NonNullable<Row> : never): boolean {
  const defended = [...ctx.db.player.zoneId.filter(project.zoneId)].some((player) => {
    if (!player.online || player.dead) return false;
    const pos = settle(ctx, player, ctx.timestamp);
    return Math.hypot(pos.x - project.x, pos.y - project.y) <= IGNITION_DEFENSE_RADIUS;
  });
  if (!defended) return false;
  return ![...ctx.db.darkCreature.zoneId.filter(project.zoneId)].some(
    (creature) => creature.health > 0 && Math.hypot(creature.x - project.x, creature.y - project.y) <= IGNITION_DEFENSE_RADIUS,
  );
}

function completeIgnition(ctx: Ctx, project: ReturnType<Ctx["db"]["project"]["id"]["find"]> extends infer Row ? NonNullable<Row> : never): void {
  if (!ignitionDefended(ctx, project)) {
    ctx.db.project.id.update({ ...project, status: "failed" });
    return;
  }
  const existing = [...ctx.db.brazier.zoneId.filter(project.zoneId)].find((row) => row.x === project.x && row.y === project.y);
  if (existing) ctx.db.brazier.id.update({ ...existing, radius: BRAZIER_RADIUS, lit: true, isEternal: false });
  else ctx.db.brazier.insert({ id: 0n, zoneId: project.zoneId, x: project.x, y: project.y, radius: BRAZIER_RADIUS, lit: true, isEternal: false });
  ctx.db.project.id.update({ ...project, status: "completed" });
  ensureWorldRings(ctx);
  armBrazierUpkeep(ctx);
}

export function runIgnitions(ctx: Ctx): void {
  for (const project of [...ctx.db.project.iter()]) {
    if (project.status !== "active") continue;
    if (elapsedMs(project.endsAt, ctx.timestamp) >= 0) completeIgnition(ctx, project);
    else spawnIgnitionWave(ctx, project);
  }
}
