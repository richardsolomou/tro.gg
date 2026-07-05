import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  darkCreatureLoot,
  DARK_CREATURE_AGGRO_RANGE,
  DARK_CREATURE_ATTACK_COOLDOWN_MS,
  DARK_CREATURE_DAMAGE,
  DARK_CREATURE_MAX_HEALTH,
  elapsedMs,
  EMBER_HEART_DROP_CHANCE,
  EMBER_HEART_ITEM,
  EMBER_WANDER_TICK_MS,
  footprintWalkable,
  getZone,
  MAX_DARK_CREATURES_PER_ZONE,
  meleeHit,
  PLAYER_HIT_RADIUS,
  projectMotion,
  spawnTile,
  tileKey,
  type Stamp,
  type Zone,
  type ZoneBounds,
  zoneBounds,
} from "../../shared/index";
import { obstacleTiles, addPlayerTiles, pickWanderDir, countRows, darkCreatureAt } from "./tiles";
import { isLit } from "./braziers";
import { damagePlayer, dropLoot } from "./combat";
import type { Ctx } from "./schema";

/** Seed a zone's dark creatures from the registry, unless it already has some. */
export function seedDarkCreatures(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.darkCreature.zoneId.filter(zone.slug)].length > 0) return;
  for (const tile of zone.darkCreatures) {
    ctx.db.darkCreature.insert({
      id: 0n,
      zoneId: zone.slug,
      x: tile.x,
      y: tile.y,
      dirX: 0,
      dirY: 0,
      movedAt: Timestamp.UNIX_EPOCH,
      species: "wretch",
      health: DARK_CREATURE_MAX_HEALTH,
      lastDamagedAt: Timestamp.UNIX_EPOCH,
      aggroTargetId: "",
      lastAttackAt: Timestamp.UNIX_EPOCH,
    });
  }
}

/** Arm the ember/dark-creature wander sweep, unless one is already pending. */
export function armEmberWander(ctx: Ctx): void {
  if (ctx.db.emberWanderTimer.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(EMBER_WANDER_TICK_MS) * 1000n;
  ctx.db.emberWanderTimer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

/** The walkable cardinal step closest to the desired (stepX, stepY) direction —
 *  used while chasing, since a straight line toward the target is often
 *  blocked and a creature that just stops looks broken. */
function closestWalkableStep(bounds: ZoneBounds, x: number, y: number, stepX: number, stepY: number): { dirX: number; dirY: number } | undefined {
  const candidates: { dirX: number; dirY: number }[] =
    stepX !== 0 && stepY !== 0
      ? [
          { dirX: stepX, dirY: stepY },
          { dirX: stepX, dirY: 0 },
          { dirX: 0, dirY: stepY },
        ]
      : [{ dirX: stepX, dirY: stepY }];
  for (const c of candidates) {
    if ((c.dirX !== 0 || c.dirY !== 0) && footprintWalkable(bounds, x + c.dirX, y + c.dirY)) return c;
  }
  return undefined;
}

/** The nearest bright, living trogg in aggro range, keeping an existing target
 *  a little past first-acquire range while it's still alive rather than
 *  re-picking every tick. */
function acquireTarget(ctx: Ctx, d: { zoneId: string; aggroTargetId: string }, x: number, y: number) {
  let best: ReturnType<Ctx["db"]["player"]["identity"]["find"]> | undefined;
  let bestDist = Infinity;
  for (const p of ctx.db.player.zoneId.filter(d.zoneId)) {
    if (!p.online || p.dead) continue;
    const dist = Math.hypot(p.x - x, p.y - y);
    const range = p.identity.toHexString() === d.aggroTargetId ? DARK_CREATURE_AGGRO_RANGE * 1.5 : DARK_CREATURE_AGGRO_RANGE;
    if (dist > range) continue;
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Move and fight every dark creature (GDD "Dark creatures") — the direct
 * successor of the retired `wanderHogs`. Bound by the light: a lit tile is
 * solid ground a dark creature cannot cross (the Territory-and-permanence rule
 * that makes the frontline legible). Aggressive on sight: within
 * `DARK_CREATURE_AGGRO_RANGE` of a bright trogg, it breaks its wander and
 * closes the distance instead, attacking on the same swing/hit-circle grammar
 * as a trogg once in reach.
 */
export function wanderDarkCreatures(ctx: Ctx, now: Stamp): void {
  const blockersByZone = new Map<string, Set<string>>();
  const blockersFor = (zoneId: string): Set<string> => {
    let set = blockersByZone.get(zoneId);
    if (!set) {
      set = obstacleTiles(ctx, zoneId);
      addPlayerTiles(ctx, zoneId, now, set);
      blockersByZone.set(zoneId, set);
    }
    return set;
  };

  const list = [...ctx.db.darkCreature.iter()];
  type Row = (typeof list)[number];
  const settled: { row: Row; x: number; y: number; zone: Zone; blockers: Set<string> }[] = [];
  const occupiedByZone = new Map<string, Set<string>>();
  for (const d of list) {
    const zone = getZone(d.zoneId);
    if (!zone) continue;
    if (d.health <= 0) continue; // corpses lie where they fell
    const blockers = blockersFor(d.zoneId);
    const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)) || isLit(ctx, d.zoneId, x, y));
    const pos = projectMotion(d, elapsedMs(d.movedAt, now), bounds);
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    settled.push({ row: d, x, y, zone, blockers });
    let tiles = occupiedByZone.get(d.zoneId);
    if (!tiles) {
      tiles = new Set<string>();
      occupiedByZone.set(d.zoneId, tiles);
    }
    tiles.add(tileKey(x, y));
  }

  const claimedByZone = new Map<string, Set<string>>();
  for (const s of settled) {
    const own = tileKey(s.x, s.y);
    const otherTiles = occupiedByZone.get(s.row.zoneId)!;
    let claimed = claimedByZone.get(s.row.zoneId);
    if (!claimed) {
      claimed = new Set<string>();
      claimedByZone.set(s.row.zoneId, claimed);
    }
    const bounds = zoneBounds(s.zone, (x, y) => {
      const k = tileKey(x, y);
      if (k === own) return false;
      return s.blockers.has(k) || otherTiles.has(k) || claimed!.has(k) || isLit(ctx, s.row.zoneId, x, y);
    });

    // Aggro: keep an existing target while it's still in range and alive; else
    // pick the nearest bright trogg within DARK_CREATURE_AGGRO_RANGE.
    const target = acquireTarget(ctx, s.row, s.x, s.y);
    if (target) {
      const dx = target.x + 0.5 - (s.x + 0.5);
      const dy = target.y + 0.5 - (s.y + 0.5);
      const dist = Math.hypot(dx, dy);
      const attackReady = elapsedMs(s.row.lastAttackAt, now) >= DARK_CREATURE_ATTACK_COOLDOWN_MS;
      const swing = meleeHit(s.x + 0.5, s.y + 0.5, dx, dy, { x: target.x + 0.5, y: target.y + 0.5, radius: PLAYER_HIT_RADIUS });
      if (swing !== undefined && attackReady) {
        const roll = ctx.random.integerInRange(DARK_CREATURE_DAMAGE[0], DARK_CREATURE_DAMAGE[1]);
        damagePlayer(ctx, target, roll);
        ctx.db.darkCreature.id.update({ ...s.row, aggroTargetId: target.identity.toHexString(), lastAttackAt: ctx.timestamp, dirX: Math.sign(dx), dirY: Math.sign(dy), movedAt: ctx.timestamp });
        continue;
      }
      const stepX = dist > 0 ? Math.sign(dx) : 0;
      const stepY = dist > 0 ? Math.sign(dy) : 0;
      const step = closestWalkableStep(bounds, s.x, s.y, stepX, stepY);
      if (step) claimed.add(tileKey(s.x + step.dirX, s.y + step.dirY));
      const unchanged =
        s.x === s.row.x && s.y === s.row.y && (step?.dirX ?? 0) === s.row.dirX && (step?.dirY ?? 0) === s.row.dirY && s.row.aggroTargetId === target.identity.toHexString();
      if (!unchanged) {
        ctx.db.darkCreature.id.update({
          ...s.row,
          x: s.x,
          y: s.y,
          dirX: step?.dirX ?? 0,
          dirY: step?.dirY ?? 0,
          aggroTargetId: target.identity.toHexString(),
          movedAt: ctx.timestamp,
        });
      }
      continue;
    }

    // No target: continue an existing wander run, or pick a fresh heading.
    const moving = s.row.dirX !== 0 || s.row.dirY !== 0;
    if (moving) {
      const stepX = Math.sign(s.row.dirX);
      const stepY = Math.sign(s.row.dirY);
      if (footprintWalkable(bounds, s.x + stepX, s.y + stepY)) {
        claimed.add(tileKey(s.x + stepX, s.y + stepY));
        continue;
      }
    }
    const dir = pickWanderDir(ctx, bounds, { x: s.x, y: s.y });
    if (dir.dirX !== 0 || dir.dirY !== 0) claimed.add(tileKey(s.x + dir.dirX, s.y + dir.dirY));
    const unchanged = s.x === s.row.x && s.y === s.row.y && dir.dirX === s.row.dirX && dir.dirY === s.row.dirY && s.row.aggroTargetId === "";
    if (unchanged) continue;
    ctx.db.darkCreature.id.update({ ...s.row, x: s.x, y: s.y, dirX: dir.dirX, dirY: dir.dirY, aggroTargetId: "", movedAt: ctx.timestamp });
  }
}

/**
 * Apply damage to a dark creature; zero health leaves a corpse in place
 * (reaped by the regen sweep, GDD "Combat"). The killing blow drops its loot,
 * plus a chance of an ember-heart if the kill lands on ground no hearth
 * currently lights (GDD "The fire and the dark" → Ignition).
 */
export function damageDarkCreature(ctx: Ctx, target: NonNullable<ReturnType<typeof darkCreatureAt>>, amount: number): { health: number; killed: boolean; dealt: number } {
  const health = Math.max(0, target.health - amount);
  ctx.db.darkCreature.id.update({ ...target, health, lastDamagedAt: ctx.timestamp });
  if (health > 0) return { health, killed: false, dealt: amount };

  dropLoot(ctx, target.zoneId, darkCreatureLoot(), { x: target.x, y: target.y });
  if (!isLit(ctx, target.zoneId, target.x, target.y) && ctx.random() < EMBER_HEART_DROP_CHANCE) {
    const zone = getZone(target.zoneId);
    if (zone) {
      const occupied = obstacleTiles(ctx, target.zoneId);
      const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), target.x, target.y, 0, 0);
      if (tile) ctx.db.groundItem.insert({ id: 0n, zoneId: target.zoneId, item: EMBER_HEART_ITEM, x: tile.x, y: tile.y, qty: 1 });
    }
  }
  return { health: 0, killed: true, dealt: amount };
}

/**
 * The out-of-combat regen sweep's dark-creature pass (GDD "Combat", "Dark
 * creatures"): heal the living, and reap corpses after `NPC_CORPSE_MS`.
 * Territory-linked respawn (GDD "The fire and the dark" → Territory and
 * permanence): a corpse reaped on ground still unlit — the dark's own — is
 * replaced with a fresh spawn at the same tile; one reaped on lit, claimed
 * ground stays gone for good.
 */
export function regenDarkCreatures(ctx: Ctx, now: Stamp, npcCorpseMs: number, healthRegenDelayMs: number, healthRegenFraction: number): void {
  for (const d of ctx.db.darkCreature.iter()) {
    if (d.health <= 0) {
      if (elapsedMs(d.lastDamagedAt, now) < npcCorpseMs) continue;
      ctx.db.darkCreature.id.delete(d.id);
      if (!isLit(ctx, d.zoneId, d.x, d.y) && countRows(ctx.db.darkCreature.zoneId.filter(d.zoneId)) < MAX_DARK_CREATURES_PER_ZONE) {
        ctx.db.darkCreature.insert({
          id: 0n,
          zoneId: d.zoneId,
          x: d.x,
          y: d.y,
          dirX: 0,
          dirY: 0,
          movedAt: ctx.timestamp,
          species: d.species,
          health: DARK_CREATURE_MAX_HEALTH,
          lastDamagedAt: ctx.timestamp,
          aggroTargetId: "",
          lastAttackAt: Timestamp.UNIX_EPOCH,
        });
      }
      continue;
    }
    if (d.health >= DARK_CREATURE_MAX_HEALTH || elapsedMs(d.lastDamagedAt, now) < healthRegenDelayMs) continue;
    ctx.db.darkCreature.id.update({ ...d, health: Math.min(DARK_CREATURE_MAX_HEALTH, d.health + Math.ceil(DARK_CREATURE_MAX_HEALTH * healthRegenFraction)) });
  }
}
