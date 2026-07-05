import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRAZIER_RADIUS,
  BRAZIER_UPKEEP_ITEM,
  BRAZIER_UPKEEP_RATE,
  DARK_CREATURE_MAX_HEALTH,
  FIRST_FIRE_RADIUS,
  getZone,
  IGNITION_FUEL_COST,
  IGNITION_WINDOW_MS,
  NPC_CORPSE_MS,
  WEAPON_DAMAGE,
} from "@trogg/shared";
import { interact, onConnect, regenCreatures, sweepBrazierUpkeep, sweepEmberWander, useEquipped } from "../spacetimedb/src/index.ts";
import { id, makeCtx, playerRow } from "./spacetime.ts";

const ZONE = "world";
const micros = (ms: number) => BigInt(ms) * 1000n;
const WORLD_SPAWN = getZone(ZONE)!.spawn!;

function withPlayer(over: Record<string, unknown> = {}, ctxOver: Partial<Parameters<typeof makeCtx>[0]> = {}) {
  const me = id("me");
  const ctx = makeCtx({ sender: me, ...ctxOver });
  ctx.db.player.insert(playerRow(me, over));
  return { ctx, me };
}

// Far from WORLD_SPAWN (and so from the First Fire's light) in every direction.
const DARK_X = 5;
const DARK_Y = 5;

test("onConnect seeds the zone's First Fire as one eternal, lit brazier at spawn", () => {
  const ctx = makeCtx({ sender: id("newcomer") });
  onConnect(ctx);
  const fires = ctx.db.brazier.rows().filter((b: any) => b.zoneId === ZONE);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].isEternal, true);
  assert.equal(fires[0].lit, true);
  assert.equal(fires[0].radius, FIRST_FIRE_RADIUS);
  assert.equal(fires[0].x, WORLD_SPAWN.x);
  assert.equal(fires[0].y, WORLD_SPAWN.y);
});

test("onConnect seeds dark creatures once, idempotently across reconnects", () => {
  const ctx = makeCtx({ sender: id("first") });
  onConnect(ctx);
  const seeded = ctx.db.darkCreature.rows().filter((d: any) => d.zoneId === ZONE).length;
  assert.ok(seeded > 0);

  onConnect({ ...ctx, sender: id("second") }); // a different connection, same underlying db
  assert.equal(ctx.db.darkCreature.rows().filter((d: any) => d.zoneId === ZONE).length, seeded);
});

test("brazier upkeep guttermost-first: an unaffordable frontier brazier gutters before the nearer one", () => {
  const { ctx } = withPlayer({ online: true, x: DARK_X, y: DARK_Y });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: WORLD_SPAWN.x, y: WORLD_SPAWN.y, radius: FIRST_FIRE_RADIUS, lit: true, isEternal: true });
  const near = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: WORLD_SPAWN.x + 20, y: WORLD_SPAWN.y, radius: BRAZIER_RADIUS, lit: true, isEternal: false });
  const far = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: WORLD_SPAWN.x + 60, y: WORLD_SPAWN.y, radius: BRAZIER_RADIUS, lit: true, isEternal: false });
  // enough wood for exactly one of the two non-eternal braziers this tick
  ctx.db.stockpile.insert({ item: BRAZIER_UPKEEP_ITEM, qty: BRAZIER_UPKEEP_RATE });

  sweepBrazierUpkeep(ctx, {});

  assert.equal(ctx.db.brazier.id.find(far.id).lit, false, "the farther brazier gutters first");
  assert.equal(ctx.db.brazier.id.find(near.id).lit, true, "the nearer brazier stays lit");
  assert.equal(ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM).qty, 0);
});

test("brazier upkeep never touches the eternal First Fire, even fully starved", () => {
  const { ctx } = withPlayer({ online: true, x: DARK_X, y: DARK_Y });
  const fire = ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: WORLD_SPAWN.x, y: WORLD_SPAWN.y, radius: FIRST_FIRE_RADIUS, lit: true, isEternal: true });
  ctx.db.stockpile.insert({ item: BRAZIER_UPKEEP_ITEM, qty: 0 });

  sweepBrazierUpkeep(ctx, {});

  assert.equal(ctx.db.brazier.id.find(fire.id).lit, true);
});

test("picking up an ember-heart carries it, never into personal inventory", () => {
  const { ctx, me } = withPlayer({ x: DARK_X, y: DARK_Y, carrying: "" });
  ctx.db.groundItem.insert({ id: 0n, zoneId: ZONE, item: "ember-heart", x: DARK_X + 1, y: DARK_Y, qty: 1 });
  interact(ctx, { dirX: 1, dirY: 0 });
  assert.equal(ctx.db.groundItem.rows().length, 0);
  assert.equal(ctx.db.inventory.rows().length, 0);
  assert.equal(ctx.db.player.identity.find(me).carrying, "ember-heart");
});

test("putting down a carried ember-heart on unlit ground with fuel banked lights an ignition", () => {
  const { ctx, me } = withPlayer({ x: DARK_X, y: DARK_Y, carrying: "ember-heart" });
  ctx.db.stockpile.insert({ item: BRAZIER_UPKEEP_ITEM, qty: IGNITION_FUEL_COST });

  interact(ctx, { dirX: 0, dirY: 1 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "", "the ember-heart is spent, not dropped");
  assert.equal(ctx.db.groundItem.rows().length, 0, "no ground item — it was delivered, not dropped");
  assert.equal(ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM).qty, 0);
  const projects = ctx.db.project.rows();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].status, "active");
  assert.ok(ctx.db.darkCreature.rows().length > 0, "the dark answers with a wave");
});

test("putting down an ember-heart on already-lit ground is an ordinary drop, not an ignition", () => {
  const { ctx, me } = withPlayer({ x: DARK_X, y: DARK_Y, carrying: "ember-heart" });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: DARK_X, y: DARK_Y, radius: BRAZIER_RADIUS, lit: true, isEternal: false });
  ctx.db.stockpile.insert({ item: BRAZIER_UPKEEP_ITEM, qty: IGNITION_FUEL_COST });

  interact(ctx, { dirX: 0, dirY: 1 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(ctx.db.groundItem.rows().length, 1, "landed as an inert ground item");
  assert.equal(ctx.db.project.rows().length, 0);
  assert.equal(ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM).qty, IGNITION_FUEL_COST, "no fuel spent");
});

test("igniting without enough banked fuel falls back to an ordinary drop", () => {
  const { ctx, me } = withPlayer({ x: DARK_X, y: DARK_Y, carrying: "ember-heart" });
  ctx.db.stockpile.insert({ item: BRAZIER_UPKEEP_ITEM, qty: IGNITION_FUEL_COST - 1 });

  interact(ctx, { dirX: 0, dirY: 1 });

  assert.equal(ctx.db.player.identity.find(me).carrying, "");
  assert.equal(ctx.db.groundItem.rows()[0]?.item, "ember-heart");
  assert.equal(ctx.db.project.rows().length, 0);
  assert.equal(ctx.db.stockpile.item.find(BRAZIER_UPKEEP_ITEM).qty, IGNITION_FUEL_COST - 1, "the stake is untouched on a refused ignition");
});

test("an active ignition resolves into a lit brazier once its window elapses", () => {
  const { ctx } = withPlayer({ online: true, x: DARK_X, y: DARK_Y });
  ctx.db.frontier.insert({ zoneId: ZONE, ringsRevealed: 1 });
  ctx.db.project.insert({
    id: 0n,
    slug: "ignition",
    zoneId: ZONE,
    x: DARK_X + 10,
    y: DARK_Y + 10,
    status: "active",
    fuelSpent: IGNITION_FUEL_COST,
    emberHeartSpent: true,
    ignitionEndsAt: { microsSinceUnixEpoch: 0n },
  });

  sweepEmberWander(ctx, {});

  const proj = ctx.db.project.rows()[0];
  assert.equal(proj.status, "succeeded");
  const lit = ctx.db.brazier.rows().find((b: any) => b.x === DARK_X + 10 && b.y === DARK_Y + 10);
  assert.ok(lit);
  assert.equal(lit.lit, true);
  assert.equal(lit.isEternal, false);
  assert.equal(ctx.db.frontier.zoneId.find(ZONE).ringsRevealed, 2, "success advances which ring counts as current");
});

test("an ignition whose window hasn't elapsed yet stays active", () => {
  const { ctx } = withPlayer({ online: true, x: DARK_X, y: DARK_Y }, { now: micros(0) });
  ctx.db.project.insert({
    id: 0n,
    slug: "ignition",
    zoneId: ZONE,
    x: DARK_X + 10,
    y: DARK_Y + 10,
    status: "active",
    fuelSpent: IGNITION_FUEL_COST,
    emberHeartSpent: true,
    ignitionEndsAt: { microsSinceUnixEpoch: micros(IGNITION_WINDOW_MS) },
  });

  sweepEmberWander(ctx, {});

  assert.equal(ctx.db.project.rows()[0].status, "active");
  assert.equal(ctx.db.brazier.rows().length, 0);
});

test("a sword hit kills a dark creature, leaves a corpse, and drops loot", () => {
  const { ctx, me } = withPlayer({ x: DARK_X, y: DARK_Y, equippedMainHand: "sword" });
  const sword = ctx.db.inventory.insert({ id: 0n, playerId: me, item: "sword", qty: 1 });
  ctx.db.player.identity.update({ ...ctx.db.player.identity.find(me), equippedMainHandInventoryId: sword.id });
  const wretch = ctx.db.darkCreature.insert({
    id: 0n,
    zoneId: ZONE,
    x: DARK_X + 1,
    y: DARK_Y,
    dirX: 0,
    dirY: 0,
    movedAt: { microsSinceUnixEpoch: 0n },
    species: "wretch",
    health: WEAPON_DAMAGE.sword![0],
    lastDamagedAt: { microsSinceUnixEpoch: 0n },
    aggroTargetId: "",
    lastAttackAt: { microsSinceUnixEpoch: 0n },
  });

  useEquipped(ctx, { dirX: 1, dirY: 0 });

  const corpse = ctx.db.darkCreature.id.find(wretch.id);
  assert.equal(corpse.health, 0);
  assert.ok(ctx.db.groundItem.rows().some((g: any) => g.item === "stone"), "the killing blow drops loot");
});

test("a dark-creature corpse reaped on unlit ground respawns; one reaped on lit ground doesn't", () => {
  const { ctx } = withPlayer({ online: true, x: DARK_X, y: DARK_Y }, { now: micros(NPC_CORPSE_MS + 1000) });
  const unlit = ctx.db.darkCreature.insert({
    id: 0n,
    zoneId: ZONE,
    x: DARK_X + 40,
    y: DARK_Y,
    dirX: 0,
    dirY: 0,
    movedAt: { microsSinceUnixEpoch: 0n },
    species: "wretch",
    health: 0,
    lastDamagedAt: { microsSinceUnixEpoch: 0n },
    aggroTargetId: "",
    lastAttackAt: { microsSinceUnixEpoch: 0n },
  });
  const lit = ctx.db.darkCreature.insert({
    id: 0n,
    zoneId: ZONE,
    x: DARK_X + 5,
    y: DARK_Y,
    dirX: 0,
    dirY: 0,
    movedAt: { microsSinceUnixEpoch: 0n },
    species: "wretch",
    health: 0,
    lastDamagedAt: { microsSinceUnixEpoch: 0n },
    aggroTargetId: "",
    lastAttackAt: { microsSinceUnixEpoch: 0n },
  });
  ctx.db.brazier.insert({ id: 0n, zoneId: ZONE, x: DARK_X + 5, y: DARK_Y, radius: BRAZIER_RADIUS, lit: true, isEternal: false });

  regenCreatures(ctx, {});

  assert.equal(ctx.db.darkCreature.id.find(unlit.id), undefined, "the corpse itself is reaped");
  assert.ok(
    ctx.db.darkCreature.rows().some((d: any) => d.x === DARK_X + 40 && d.y === DARK_Y && d.health === DARK_CREATURE_MAX_HEALTH),
    "the dark replenishes what's its own",
  );
  assert.equal(ctx.db.darkCreature.id.find(lit.id), undefined, "the lit-ground corpse is reaped");
  assert.equal(
    ctx.db.darkCreature.rows().some((d: any) => d.x === DARK_X + 5 && d.y === DARK_Y),
    false,
    "nothing dark returns where the tribe holds the light",
  );
});
