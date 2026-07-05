import { Timestamp } from "spacetimedb";
import {
  BRAZIER_RADIUS,
  BRAZIER_UPKEEP_ITEM,
  DARK_CREATURE_MAX_HEALTH,
  elapsedMs,
  EMBER_HEART_ITEM,
  generateFrontierRing,
  getZone,
  IGNITION_FUEL_COST,
  IGNITION_RANGE_TILES,
  IGNITION_WINDOW_MS,
  MAX_DARK_CREATURES_PER_ZONE,
  RING_WAVE_SIZE,
  RING_WIDTH_TILES,
  spawnTile,
  tileKey,
  type Stamp,
} from "../../shared/index";
import { countRows } from "./tiles";
import { isLit } from "./braziers";
import type { Ctx, AnalyticsEvent } from "./schema";

/** How many dark creatures answer a fresh ignition (GDD "Ignition" — "the dark
 *  answers with waves at the nascent flame"). (initial) */
const IGNITION_WAVE_SIZE = 5;

/**
 * Try to light a new brazier, or relight a guttered one, at (tx, ty) — GDD
 * "The fire and the dark" → Ignition. Called from `interact`'s put-down
 * branch: putting down a carried ember-heart on unlit ground with enough
 * fuel banked *is* delivering it (GDD "Interacting"), rather than a separate
 * action. Returns `undefined` when the site or stake doesn't qualify, so the
 * caller falls back to an ordinary put-down (the ember-heart lands as a
 * ground item instead of being spent).
 *
 * Two keys: the carried ember-heart (consumed by the caller on success), and
 * `IGNITION_FUEL_COST` of `BRAZIER_UPKEEP_ITEM` drawn from the stockpile here
 * — both spent up front, the stake a failed hold-the-point loses. Success is
 * a scheduled sweep (`resolveIgnitions`) once `IGNITION_WINDOW_MS` elapses; a
 * wave of dark creatures spawns immediately to contest it.
 */
export function tryIgniteBrazier(ctx: Ctx, p: NonNullable<ReturnType<Ctx["db"]["player"]["identity"]["find"]>>, tx: number, ty: number): AnalyticsEvent[] | undefined {
  if (isLit(ctx, p.zoneId, tx, ty)) return undefined; // must be out where no hearth reaches

  const stockRow = ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM);
  const available = stockRow?.qty ?? 0;
  if (available < IGNITION_FUEL_COST) return undefined;

  // Already mid-ignition here? One nascent flame per site at a time.
  const nearbyActive = [...ctx.db.project.zoneId.filter(p.zoneId)].some(
    (proj) => proj.status === "active" && Math.hypot(proj.x - tx, proj.y - ty) <= IGNITION_RANGE_TILES,
  );
  if (nearbyActive) return undefined;

  ctx.db.stockpile.item.update({ ...stockRow!, qty: available - IGNITION_FUEL_COST });

  const endsAt = new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(IGNITION_WINDOW_MS) * 1000n);
  ctx.db.project.insert({
    id: 0n,
    slug: "ignition",
    zoneId: p.zoneId,
    x: tx,
    y: ty,
    status: "active",
    fuelSpent: IGNITION_FUEL_COST,
    emberHeartSpent: true,
    ignitionEndsAt: endsAt,
  });

  spawnIgnitionWave(ctx, p.zoneId, tx, ty);

  return [{ distinctId: p.identity.toHexString(), event: "project_contributed", properties: { project: "ignition", item: BRAZIER_UPKEEP_ITEM, qty: IGNITION_FUEL_COST } }];
}

/** Spawn a wave of dark creatures around an ignition site, honouring the
 *  zone's dark-creature cap — the site's own contested ground, not the
 *  ambient wilds. */
function spawnIgnitionWave(ctx: Ctx, zoneId: string, x: number, y: number): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  for (let i = 0; i < IGNITION_WAVE_SIZE; i++) {
    if (countRows(ctx.db.darkCreature.zoneId.filter(zoneId)) >= MAX_DARK_CREATURES_PER_ZONE) return;
    const occupied = new Set<string>();
    for (const d of ctx.db.darkCreature.zoneId.filter(zoneId)) occupied.add(tileKey(d.x, d.y));
    const angle = (i / IGNITION_WAVE_SIZE) * Math.PI * 2;
    const ring = 3 + (i % 2);
    const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), Math.round(x + Math.cos(angle) * ring), Math.round(y + Math.sin(angle) * ring), 0, 0);
    if (!tile) continue;
    ctx.db.darkCreature.insert({
      id: 0n,
      zoneId,
      x: tile.x,
      y: tile.y,
      dirX: 0,
      dirY: 0,
      movedAt: ctx.timestamp,
      species: "wretch",
      health: DARK_CREATURE_MAX_HEALTH,
      lastDamagedAt: ctx.timestamp,
      aggroTargetId: "",
      lastAttackAt: Timestamp.UNIX_EPOCH,
    });
  }
}

/**
 * Resolve every ignition whose hold-the-point window has elapsed (GDD "The
 * fire and the dark" → Ignition): light the brazier — a fresh row, or an
 * existing guttered one at the same site relit — and mark the project
 * succeeded. Fired from the ember/dark-creature wander sweep, so it resolves
 * within a tick or two of the window closing rather than a whole minute late.
 */
export function resolveIgnitions(ctx: Ctx, now: Stamp): void {
  for (const proj of ctx.db.project.iter()) {
    if (proj.status !== "active") continue;
    if (elapsedMs(proj.ignitionEndsAt, now) < 0) continue;

    const guttered = [...ctx.db.brazier.zoneId.filter(proj.zoneId)].find(
      (b) => !b.lit && !b.isEternal && Math.hypot(b.x - proj.x, b.y - proj.y) <= IGNITION_RANGE_TILES,
    );
    if (guttered) ctx.db.brazier.id.update({ ...guttered, lit: true });
    else ctx.db.brazier.insert({ id: 0n, zoneId: proj.zoneId, x: proj.x, y: proj.y, radius: BRAZIER_RADIUS, lit: true, isEternal: false });

    ctx.db.project.id.update({ ...proj, status: "succeeded" });
    revealNextRing(ctx, proj.zoneId);
  }
}

/**
 * Advance a zone's frontier by one ring and seed it with a fresh batch of
 * dark creatures (GDD "The fire and the dark" → Generation): a successful
 * ignition is what "simply advances which ring counts as current." The ring
 * itself is a pure function of the tilemap and its own index
 * (`generateFrontierRing`) — generated once here, never reshuffled after.
 */
function revealNextRing(ctx: Ctx, zoneId: string): void {
  const zone = getZone(zoneId);
  const front = ctx.db.frontier.zoneId.find(zoneId);
  if (!zone || !front) return;
  const ringIndex = front.ringsRevealed;
  ctx.db.frontier.zoneId.update({ ...front, ringsRevealed: ringIndex + 1 });

  const spawn = zone.spawn ?? { x: 0, y: 0 };
  const tiles = generateFrontierRing(zone.tiles, spawn, ringIndex, RING_WIDTH_TILES, RING_WAVE_SIZE);
  for (const tile of tiles) {
    if (countRows(ctx.db.darkCreature.zoneId.filter(zoneId)) >= MAX_DARK_CREATURES_PER_ZONE) break;
    ctx.db.darkCreature.insert({
      id: 0n,
      zoneId,
      x: tile.x,
      y: tile.y,
      dirX: 0,
      dirY: 0,
      movedAt: ctx.timestamp,
      species: "wretch",
      health: DARK_CREATURE_MAX_HEALTH,
      lastDamagedAt: ctx.timestamp,
      aggroTargetId: "",
      lastAttackAt: Timestamp.UNIX_EPOCH,
    });
  }
}
