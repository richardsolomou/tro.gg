import spacetimedb from "../schema";
import { Timestamp } from "spacetimedb";
import {
  CAVE_DOOR,
  EMERGE_ARRIVAL,
  nearestSafeTile,
  COLOR_UNSET,
  getZone,
  STYLE_UNSET,
  isWalkable,
  PLAYER_MAX_HEALTH,
  STARTING_ZONE_SLUG,
} from "../../../shared/index";
import {
  spawnAt,
  healStaleWorld,
  seedBoulders,
  seedTrees,
  seedHogs,
  seedGroundItems,
  seedBirthInstance,
  playerConnectionCount,
  rememberPlayerConnection,
  forgetPlayerConnection,
  armWander,
  armRegen,
  isSpacetimeAuthCaller,
  claimProviderName,
  settle,
  solidTiles,
  placeCarried,
  facingDir,
} from "../helpers";

export const init = spacetimedb.init(() => {});

/**
 * A client connected. Resume the existing trogg (mark it online) or spawn a fresh
 * one at the zone centre. The durable row already is the player — there is no
 * separate load step.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  // init runs first-publish only, so it can't seed a table added to an already-published
  // module; seed lazily on connect, idempotently.
  const startingZone = getZone(STARTING_ZONE_SLUG)!;
  healStaleWorld(ctx, startingZone);
  seedBoulders(ctx, startingZone);
  seedTrees(ctx, startingZone);
  seedHogs(ctx, startingZone);
  seedGroundItems(ctx, startingZone);
  // A player is here, so make sure the Hogs are roaming (no-op if already armed).
  armWander(ctx);
  armRegen(ctx);

  const hadLiveConnection = playerConnectionCount(ctx, ctx.sender) > 0;
  rememberPlayerConnection(ctx);

  let existing = ctx.db.player.identity.find(ctx.sender);
  // Rows from the retired zone-instanced world carry old slugs; fold them into
  // the seamless world at spawn.
  if (existing && !getZone(existing.zoneId)) {
    const at = spawnAt(startingZone);
    existing = { ...existing, zoneId: STARTING_ZONE_SLUG, x: at.x, y: at.y, dirX: 0, dirY: 0, running: false, path: "" };
    ctx.db.player.identity.update(existing);
  }
  if (existing) {
    // The same account can have several live sockets (two tabs, or two devices).
    // They all control and observe one trogg row. Only the first live connection
    // should resume/reset presence; later connections must not stop an in-flight
    // movement intent that the already-active tab is driving.
    if (existing.online && hadLiveConnection) return;

    // A returning trogg is already settled (disconnect zeroes its direction), but
    // a tilemap edit could leave its resting tile inside a new wall; nudge it back
    // to spawn so it never resumes embedded in an obstacle (invariant 6).
    const zone = getZone(existing.zoneId);
    // A map regen can strand a returning trogg inside new rock or a river: relocate
    // to the nearest safe tile beside where it logged out, spawn as the last resort.
    // (A trogg mid-birth resumes inside its own private cave, untouched.)
    const stuck = zone && !isWalkable(zone, Math.round(existing.x), Math.round(existing.y));
    const pos = stuck ? (nearestSafeTile(zone, existing.x, existing.y) ?? spawnAt(zone)) : { x: existing.x, y: existing.y };
    ctx.db.player.identity.update({ ...existing, x: pos.x, y: pos.y, dirX: 0, dirY: 0, running: false, path: "", online: true, movedAt: ctx.timestamp });
    return;
  }

  // A connection authenticated by a SpacetimeAuth OIDC token is an account, not a
  // guest (its identity is stable across browsers/devices). Any other token —
  // including SpacetimeDB's own self-issued anonymous one — is a guest.
  const isAccount = isSpacetimeAuthCaller(ctx);

  // A newborn is born alone in its own instanced birth cave (GDD "Onboarding:
  // the Warren"): a private zone id scoping a copy of the shared template.
  const birthZone = `birth:${ctx.sender.toHexString()}`;
  const cave = getZone(birthZone)!;
  seedBirthInstance(ctx, birthZone);
  const at = cave.spawn ?? { x: 0, y: 0 };
  // Identity hex starts with a fixed `c200` tag, so name from the variable tail.
  const hex = ctx.sender.toHexString();
  const generated = `trogg-${hex.slice(-4)}`;
  // Seed an account with its provider username when it's valid and free; fall
  // back to a generated name (a fresh-device sign-in then needs no rename to play).
  const name = isAccount ? (claimProviderName(ctx) ?? generated) : generated;

  ctx.db.player.insert({
    identity: ctx.sender,
    name,
    isGuest: !isAccount,
    zoneId: birthZone,
    x: at.x,
    y: at.y,
    dirX: 0,
    dirY: 0,
    running: false,
    movedAt: ctx.timestamp,
    online: true,
    lastChatAt: undefined,
    color: COLOR_UNSET,
    carrying: "",
    carryingStyle: "",
    path: "",
    style: STYLE_UNSET,
    faceX: 0,
    faceY: -1, // facing the corridor

    equippedMainHand: "",
    equipmentAction: "",
    equipmentActionAt: Timestamp.UNIX_EPOCH,
    equippedMainHandInventoryId: 0n,
    equippedOffHand: "",
    equippedOffHandInventoryId: 0n,
    health: PLAYER_MAX_HEALTH,
    dead: false,
    respawnAt: undefined,
    lastDamagedAt: Timestamp.UNIX_EPOCH,
    cheatSpeed: 1,
    cheatFly: false,
    cheatInvulnerable: false,
    cheatNoclip: false,
    z: 0,
    dirZ: 0,
  });
});

/**
 * A client disconnected. Settle the trogg to where it is *now* and mark it
 * offline (clients subscribe to online players only, so it leaves their view
 * without losing durable progress).
 */
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (forgetPlayerConnection(ctx) > 0) return;

  const settled = settle(ctx, p, ctx.timestamp);
  // Drop whatever the trogg was carrying where it stops, so a carried entity is
  // never orphaned while its carrier is offline (GDD "Interacting"). If it's boxed
  // in and can't be placed, keep it on the row — it's durable and still droppable
  // when the trogg returns.
  let carrying = p.carrying;
  let carryingStyle = p.carryingStyle;
  if (carrying !== "") {
    const zone = getZone(p.zoneId);
    const occupied = solidTiles(ctx, p.zoneId, ctx.timestamp, p.identity);
    const face = facingDir(p);
    if (zone && placeCarried(ctx, zone, carrying, carryingStyle, occupied, settled.x, settled.y, face.dirX, face.dirY)) {
      carrying = "";
      carryingStyle = "";
    }
  }
  ctx.db.player.identity.update({ ...p, x: settled.x, y: settled.y, z: settled.z, dirZ: 0, dirX: 0, dirY: 0, running: false, path: "", online: false, carrying, carryingStyle });
});


/**
 * Step out of the birth cave (GDD "Onboarding: the Warren"): fired by the
 * client as the trogg walks onto the exit landing — no keypress; the walk IS
 * the door. The server re-derives the position and only emerges a caller
 * actually at the exit (invariant 3). The instance's rows persist: it is the
 * trogg's own cave, kept exactly as it left it, and `enterCave` leads back.
 */
export const emerge = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || p.dead) return;
  if (!p.zoneId.startsWith("birth:")) return;
  const cave = getZone(p.zoneId);
  const exit = cave?.exit;
  if (!cave || !exit) return;
  const settled = settle(ctx, p, ctx.timestamp);
  if (Math.hypot(settled.x - exit.x, settled.y - exit.y) > 2.5) return;
  ctx.db.player.identity.update({
    ...p,
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
    faceY: -1, // facing out of the cave mouth, toward the world
    movedAt: ctx.timestamp,
  });
});

/**
 * Walk back down into your own cave (GDD "Onboarding: the Warren"): fired by
 * the client as the trogg pushes into the alcove's deep end. Position is
 * re-derived and verified (invariant 3); the destination is always the
 * caller's own `birth:<identity>` instance — nobody else's cave is reachable —
 * landing on the exit ledge facing the cavern.
 */
export const enterCave = spacetimedb.reducer((ctx) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || p.dead) return;
  if (p.zoneId !== STARTING_ZONE_SLUG) return;
  const settled = settle(ctx, p, ctx.timestamp);
  if (Math.hypot(settled.x - CAVE_DOOR.x, settled.y - CAVE_DOOR.y) > 2) return;
  const birthZone = `birth:${ctx.sender.toHexString()}`;
  const cave = getZone(birthZone);
  const exit = cave?.exit;
  if (!cave || !exit) return;
  ctx.db.player.identity.update({
    ...p,
    zoneId: birthZone,
    x: exit.x,
    // land below the neck, clear of the emerge threshold — arriving in the
    // cave must not immediately walk you back out
    y: exit.y + 3,
    z: 0,
    dirZ: 0,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    faceX: 0,
    faceY: 1, // facing down into the cavern
    movedAt: ctx.timestamp,
  });
});
