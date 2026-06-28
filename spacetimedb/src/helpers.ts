import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  CARDINALS,
  elapsedMs,
  footprintTiles,
  getZone,
  GHOST_HAUNT_HISTORY_MAX,
  HOG_IDLE_CHANCE,
  hogStyleFor,
  HOG_STEP_INTERVAL_MS,
  HOG_TURN_CHANCE,
  INVENTORY_SLOT_COUNT,
  hogSize,
  isEquippableItem,
  isItemId,
  isStackableItem,
  isValidName,
  isWalkable,
  HOG_MAX_HEALTH,
  MAX_BOULDERS_PER_ZONE,
  MAX_HOGS_PER_ZONE,
  PLAYER_MAX_HEALTH,
  PLAYER_RESPAWN_MS,
  projectMotion,
  snapToTile,
  SPACETIMEAUTH_ISSUER,
  spawnTile,
  spawnTiles,
  THROWN_OBJECT_DAMAGE,
  THROWN_OBJECT_RANGE,
  type Stamp,
  tileKey,
  walkableCardinals,
  type Zone,
  type ZoneBounds,
  zoneBounds,
} from "../../shared/index";
import type { Ctx, ProcCtx, AnalyticsEvent } from "./schema";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";

export function captureProcedureEvents(ctx: ProcCtx, posthogKey: string, events: AnalyticsEvent | AnalyticsEvent[] | undefined): void {
  const key = posthogKey.trim();
  if (!key) return;
  const batch = Array.isArray(events) ? events : events ? [events] : [];
  for (const item of batch) {
    try {
      ctx.http.fetch(POSTHOG_CAPTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          event: item.event,
          distinct_id: item.distinctId,
          properties: {
            ...item.properties,
            source: item.properties?.source ?? "spacetimedb-procedure",
          },
        }),
      });
    } catch {
      // Telemetry is best-effort and must never roll back an accepted gameplay action.
    }
  }
}

export function sourceProp(source: string): Record<string, string> {
  const trimmed = source.trim();
  return trimmed ? { source: trimmed.slice(0, 64) } : {};
}

export function distinctId(ctx: Ctx): string {
  return ctx.sender.toHexString();
}

export function unit(): {} {
  return {};
}

/** A fresh trogg's spawn tile: the zone centre (a walkable interior tile). */
export function spawnAt(zone: Zone): { x: number; y: number } {
  return { x: Math.floor(zone.width / 2), y: Math.floor(zone.height / 2) };
}

/** Seed a zone's boulders from the registry, unless it already has some. */
export function seedBoulders(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.boulder.zoneId.filter(zone.slug)].length > 0) return;
  for (const b of zone.boulders) {
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: b.x, y: b.y });
  }
}

/** Seed a zone's Hogs from the registry, unless it already has some — the common
 *  roamers (style "" → client-derived skin) and the rare 2×2 showpieces (explicit
 *  style, so `hogSize` makes them big). */
export function seedHogs(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.hog.zoneId.filter(zone.slug)].length > 0) return;
  for (const h of zone.hogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: "", health: HOG_MAX_HEALTH });
  }
  for (const h of zone.bigHogs) {
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: h.x, y: h.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: h.x, homeY: h.y, style: h.style, health: HOG_MAX_HEALTH });
  }
}

/** Seed a zone's starter pickup items from the registry, unless it already has some. */
export function seedGroundItems(ctx: Ctx, zone: Zone): void {
  if ([...ctx.db.groundItem.zoneId.filter(zone.slug)].length > 0) return;
  for (const item of zone.items) {
    ctx.db.groundItem.insert({ id: 0n, zoneId: zone.slug, item: item.item, x: item.x, y: item.y, qty: 1 });
  }
}

/** Whether any player is currently online — the Hogs only roam while someone is
 *  watching (invariant 1: an empty zone does no work). */
export function anyPlayerOnline(ctx: Ctx): boolean {
  for (const p of ctx.db.player.iter()) if (p.online) return true;
  return false;
}

export function playerConnectionCount(ctx: Ctx, playerId: Ctx["sender"]): number {
  return countRows(ctx.db.playerConnection.playerId.filter(playerId));
}

export function rememberPlayerConnection(ctx: Ctx): void {
  if (!ctx.connectionId) return;
  const connectionId = ctx.connectionId.toHexString();
  if (ctx.db.playerConnection.connectionId.find(connectionId)) return;
  ctx.db.playerConnection.insert({ connectionId, playerId: ctx.sender, connectedAt: ctx.timestamp });
}

export function forgetPlayerConnection(ctx: Ctx): number {
  if (ctx.connectionId) ctx.db.playerConnection.connectionId.delete(ctx.connectionId.toHexString());
  return playerConnectionCount(ctx, ctx.sender);
}

/** Pick a walkable floor tile from a zone. Used for the cosmetic ghost haunt. */
export function randomWalkableTile(ctx: Ctx, zone: Zone): { x: number; y: number } | undefined {
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y < zone.height; y++) {
    for (let x = 0; x < zone.width; x++) {
      if (isWalkable(zone, x, y)) tiles.push({ x, y });
    }
  }
  if (tiles.length === 0) return undefined;
  return tiles[ctx.random.integerInRange(0, tiles.length - 1)];
}

/** Cap old ghost event rows for a zone; haunts are only useful as fresh inserts. */
export function trimGhostHaunts(ctx: Ctx, zoneId: string): void {
  const rows = [...ctx.db.ghostHaunt.zoneId.filter(zoneId)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const excess = rows.length - GHOST_HAUNT_HISTORY_MAX;
  for (let i = 0; i < excess; i++) ctx.db.ghostHaunt.id.delete(rows[i]!.id);
}

/** Arm a single one-shot Hog wander tick, unless one is already pending. The tick
 *  fires once per tile-crossing so a Hog re-bases (and re-checks collision) every tile
 *  (GDD "Hogs"). */
export function armWander(ctx: Ctx): void {
  if (ctx.db.hogWander.count() > 0n) return;
  const at = ctx.timestamp.microsSinceUnixEpoch + BigInt(Math.round(HOG_STEP_INTERVAL_MS)) * 1000n;
  ctx.db.hogWander.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(at) });
}

/**
 * A Hog's heading for the next tile (GDD "Hogs"). A Hog ambling in a direction keeps
 * going so long as that tile is open and a `HOG_TURN_CHANCE` roll doesn't turn it — so
 * it walks in gentle runs rather than jittering every tile. Otherwise (blocked ahead,
 * or it turned, or it was idle) it picks fresh: idle with `HOG_IDLE_CHANCE` so it
 * pauses, else a random walkable cardinal. `bounds` already treats walls, boulders,
 * troggs, and other Hogs as unwalkable, so a picked tile is always clear.
 */
export function pickWanderDir(
  ctx: Ctx,
  bounds: ZoneBounds,
  hog: { dirX: number; dirY: number },
  pos: { x: number; y: number },
  size: number,
): { dirX: number; dirY: number } {
  const options = walkableCardinals(bounds, pos.x, pos.y, size);
  const ahead = options.find((d) => d.dirX === hog.dirX && d.dirY === hog.dirY);
  if (ahead && ctx.random() > HOG_TURN_CHANCE) return ahead;
  if (ctx.random() < HOG_IDLE_CHANCE) return { dirX: 0, dirY: 0 };
  if (options.length === 0) return { dirX: 0, dirY: 0 };
  return options[ctx.random.integerInRange(0, options.length - 1)]!;
}

/** Whether the caller authenticated with a SpacetimeAuth OIDC token (an account, not a guest). */
export function isSpacetimeAuthCaller(ctx: Ctx): boolean {
  return ctx.senderAuth.hasJWT && ctx.senderAuth.jwt?.issuer === SPACETIMEAUTH_ISSUER;
}

/** A valid, free name from the caller's OIDC username claims, or undefined. */
export function claimProviderName(ctx: Ctx): string | undefined {
  const payload = ctx.senderAuth.jwt?.fullPayload ?? {};
  const candidate = payload["preferred_username"] ?? payload["name"];
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return isValidName(trimmed) && !nameTaken(ctx, trimmed, ctx.sender) ? trimmed : undefined;
}

/** Whether another player already holds `name` (case-insensitive). */
export function nameTaken(ctx: Ctx, name: string, self: Ctx["sender"]): boolean {
  const lower = name.toLowerCase();
  for (const other of ctx.db.player.iter()) {
    if (!self.isEqual(other.identity) && other.name.toLowerCase() === lower) return true;
  }
  return false;
}

/** The motion-bearing slice of a player row that `settle` derives position from. */
type Settleable = { x: number; y: number; dirX: number; dirY: number; running: boolean; path?: string; zoneId: string; movedAt: Stamp };

/**
 * Derive the trogg's position at `now` from its stored motion intent, colliding
 * against everything solid to a trogg — walls, boulders, and Hogs — so it settles
 * flush against an obstacle, never inside one, then snap it to a whole tile:
 * movement is grid-locked (GDD "Movement"), so a stored origin is always a tile
 * centre. Troggs do *not* collide with each other (GDD "Hogs"), so other players
 * are absent here. The client only sends `move` when the trogg is tile-aligned, so
 * the snap is a no-op in the normal case and a guard against a misbehaving client
 * in the rest (invariant 3).
 */
export function settle(ctx: Ctx, p: Settleable, now: Stamp): { x: number; y: number } {
  const zone = getZone(p.zoneId);
  if (!zone) return { x: p.x, y: p.y };
  const blockers = troggBlockers(ctx, p.zoneId, now);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  return snapToTile(projectMotion(p, elapsedMs(p.movedAt, now), bounds));
}

/** Count rows in a table iterable without materializing an array. */
export function countRows(rows: Iterable<unknown>): number {
  let n = 0;
  for (const _ of rows) n++;
  return n;
}

/** The set of tiles occupied by boulders in a zone, keyed by `tileKey`. */
export function boulderTiles(ctx: Ctx, zoneId: string): Set<string> {
  const tiles = new Set<string>();
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) tiles.add(tileKey(b.x, b.y));
  return tiles;
}

/** The tiles solid to a trogg in a zone: boulders + Hogs (GDD "Hogs"). Not other
 *  troggs — trogg↔trogg has no collision. Hogs re-base every tile, so their stored
 *  intent is at most one tile old; projecting against walls + boulders puts each Hog
 *  within a tile of its real spot, enough to block a trogg flush. */
export function troggBlockers(ctx: Ctx, zoneId: string, now: Stamp): Set<string> {
  const tiles = boulderTiles(ctx, zoneId);
  addHogTiles(ctx, zoneId, now, tiles);
  return tiles;
}

/** Add each Hog's current footprint (projected to `now`, against walls + boulders) to
 *  `set` — one tile for a common Hog, the whole 2×2 for a big one (GDD "Hogs"). */
export function addHogTiles(ctx: Ctx, zoneId: string, now: Stamp, set: Set<string>): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  const boulders = boulderTiles(ctx, zoneId);
  const bounds = zoneBounds(zone, (x, y) => boulders.has(tileKey(x, y)));
  for (const h of ctx.db.hog.zoneId.filter(zoneId)) {
    const size = hogSize(h.style);
    const pos = projectMotion({ ...h, size }, elapsedMs(h.movedAt, now), bounds);
    for (const tile of footprintTiles(Math.round(pos.x), Math.round(pos.y), size)) set.add(tileKey(tile.x, tile.y));
  }
}

/** Add each online trogg's current tile (projected to `now`, against walls + boulders
 *  + Hogs) to `set`, skipping `exclude` (a trogg never blocks itself). Lets Hogs and
 *  dropped objects avoid the tiles troggs stand on. */
export function addPlayerTiles(ctx: Ctx, zoneId: string, now: Stamp, set: Set<string>, exclude?: Ctx["sender"]): void {
  const zone = getZone(zoneId);
  if (!zone) return;
  const blockers = troggBlockers(ctx, zoneId, now);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  for (const p of ctx.db.player.zoneId.filter(zoneId)) {
    if (!p.online) continue;
    if (exclude && p.identity.isEqual(exclude)) continue;
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    set.add(tileKey(Math.round(pos.x), Math.round(pos.y)));
  }
}

/** Every solid tile a freshly placed entity must avoid — boulders, Hogs, and other
 *  troggs — so a spawn or drop never lands on top of something. `exclude` skips the
 *  acting trogg's own tile, leaving it as a last-resort fallback when boxed in. */
export function solidTiles(ctx: Ctx, zoneId: string, now: Stamp, exclude?: Ctx["sender"]): Set<string> {
  const tiles = boulderTiles(ctx, zoneId);
  addHogTiles(ctx, zoneId, now, tiles);
  addPlayerTiles(ctx, zoneId, now, tiles, exclude);
  return tiles;
}

/** Mark existing pickup items as visually occupied for new debug spawns. */
export function addGroundItemTiles(ctx: Ctx, zoneId: string, set: Set<string>): void {
  for (const item of ctx.db.groundItem.zoneId.filter(zoneId)) set.add(tileKey(item.x, item.y));
}

/** The boulder at a tile in a zone, or undefined. */
export function boulderAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const b of ctx.db.boulder.zoneId.filter(zoneId)) {
    if (b.x === x && b.y === y) return b;
  }
  return undefined;
}

/** The pickup item at a tile in a zone, or undefined. */
export function groundItemAt(ctx: Ctx, zoneId: string, x: number, y: number) {
  for (const item of ctx.db.groundItem.zoneId.filter(zoneId)) {
    if (item.x === x && item.y === y) return item;
  }
  return undefined;
}

/** The player's owned inventory row by id, or undefined. */
export function ownedInventoryRow(ctx: Ctx, playerId: Ctx["sender"], id: bigint) {
  const row = ctx.db.inventory.id.find(id);
  return row && row.playerId.isEqual(playerId) ? row : undefined;
}

/** The specific inventory row currently equipped, with a fallback for pre-row-id rows. */
export function equippedInventoryRow(ctx: Ctx, p: { identity: Ctx["sender"]; equippedMainHand: string; equippedMainHandInventoryId: bigint }) {
  const byId = p.equippedMainHandInventoryId !== 0n ? ownedInventoryRow(ctx, p.identity, p.equippedMainHandInventoryId) : undefined;
  if (byId && byId.qty > 0 && isEquippableItem(byId.item)) return byId;

  if (!isEquippableItem(p.equippedMainHand)) return undefined;
  for (const row of ctx.db.inventory.playerId.filter(p.identity)) {
    if (row.item === p.equippedMainHand && row.qty > 0) return row;
  }
  return undefined;
}

/**
 * Remove one unit of an owned inventory row: decrement a stack, or delete a qty=1
 * row outright. Returns the item id and whether the row's last unit was removed (so
 * the caller can unequip when the equipped row is gone), or undefined if the row
 * isn't owned or is already empty.
 */
export function removeInventoryUnit(ctx: Ctx, playerId: Ctx["sender"], inventoryId: bigint): { item: string; removedLastUnit: boolean } | undefined {
  const row = ownedInventoryRow(ctx, playerId, inventoryId);
  if (!row || row.qty <= 0) return undefined;
  if (row.qty > 1) {
    ctx.db.inventory.id.update({ ...row, qty: row.qty - 1 });
    return { item: row.item, removedLastUnit: false };
  }
  ctx.db.inventory.id.delete(row.id);
  return { item: row.item, removedLastUnit: true };
}

/** Add an item to inventory. Stackable items merge; new rows require a free carry slot. */
export function addInventory(ctx: Ctx, playerId: Ctx["sender"], item: string, qty: number): boolean {
  if (!isItemId(item) || qty <= 0) return false;
  if (isStackableItem(item)) {
    for (const row of ctx.db.inventory.playerId.filter(playerId)) {
      if (row.item === item) {
        ctx.db.inventory.id.update({ ...row, qty: row.qty + qty });
        return true;
      }
    }
    if (!hasFreeInventorySlot(ctx, playerId)) return false;
    ctx.db.inventory.insert({ id: 0n, playerId, item, qty });
    return true;
  }

  if (inventorySlotCount(ctx, playerId) + qty > INVENTORY_SLOT_COUNT) return false;
  for (let i = 0; i < qty; i++) {
    ctx.db.inventory.insert({ id: 0n, playerId, item, qty: 1 });
  }
  return true;
}

export function inventorySlotCount(ctx: Ctx, playerId: Ctx["sender"]): number {
  let count = 0;
  for (const _row of ctx.db.inventory.playerId.filter(playerId)) count++;
  return count;
}

export function hasFreeInventorySlot(ctx: Ctx, playerId: Ctx["sender"]): boolean {
  return inventorySlotCount(ctx, playerId) < INVENTORY_SLOT_COUNT;
}

/** Fold every inventory row from one identity into another, preserving item counts. */
export function moveInventory(ctx: Ctx, from: Ctx["sender"], to: Ctx["sender"]): Map<bigint, bigint> {
  const moved = new Map<bigint, bigint>();
  for (const row of [...ctx.db.inventory.playerId.filter(from)]) {
    if (isStackableItem(row.item)) {
      moved.set(row.id, mergeInventoryForClaim(ctx, to, row.item, row.qty));
    } else {
      const inserted = ctx.db.inventory.insert({ id: 0n, playerId: to, item: row.item, qty: 1 });
      moved.set(row.id, inserted.id);
    }
    ctx.db.inventory.id.delete(row.id);
  }
  return moved;
}

export function mergeInventoryForClaim(ctx: Ctx, playerId: Ctx["sender"], item: string, qty: number): bigint {
  for (const row of ctx.db.inventory.playerId.filter(playerId)) {
    if (row.item === item) {
      ctx.db.inventory.id.update({ ...row, qty: row.qty + qty });
      return row.id;
    }
  }
  return ctx.db.inventory.insert({ id: 0n, playerId, item, qty }).id;
}

/**
 * The Hog currently on a tile in a zone, or undefined. Unlike a boulder a Hog is
 * in motion, so re-derive each Hog's position at `now` (against walls and boulders,
 * like `wanderHogs`) and round to its tile before comparing — the same projection
 * the client renders, so a faced Hog matches what the player sees (invariant 3).
 */
export function hogAt(ctx: Ctx, zoneId: string, x: number, y: number, now: Stamp) {
  const zone = getZone(zoneId);
  if (!zone) return undefined;
  const occupied = boulderTiles(ctx, zoneId);
  const bounds = zoneBounds(zone, (tx, ty) => occupied.has(tileKey(tx, ty)));
  for (const h of ctx.db.hog.zoneId.filter(zoneId)) {
    // A big 2×2 Hog is a fixture, not liftable — the carry overlay is one tile, and
    // a giant on your head makes no sense — so only common Hogs answer here.
    if (hogSize(h.style) > 1) continue;
    const pos = projectMotion(h, elapsedMs(h.movedAt, now), bounds);
    if (Math.round(pos.x) === x && Math.round(pos.y) === y) return h;
  }
  return undefined;
}

export function hogTile(ctx: Ctx, h: NonNullable<ReturnType<typeof hogAt>>, now: Stamp): { x: number; y: number } {
  const zone = getZone(h.zoneId);
  if (!zone) return { x: h.x, y: h.y };
  const occupied = boulderTiles(ctx, h.zoneId);
  const bounds = zoneBounds(zone, (tx, ty) => occupied.has(tileKey(tx, ty)));
  const pos = projectMotion(h, elapsedMs(h.movedAt, now), bounds);
  return { x: Math.round(pos.x), y: Math.round(pos.y) };
}

/**
 * The online, living trogg currently on a tile in a zone, or undefined. Troggs do
 * not collide with each other, but sword attacks need a server-authoritative target
 * under the faced adjacent tile. Project each candidate at `now` with the same
 * bounds a trogg uses for movement, then round to its rendered tile.
 */
export function playerAt(ctx: Ctx, zoneId: string, x: number, y: number, now: Stamp, exclude?: Ctx["sender"]) {
  const zone = getZone(zoneId);
  if (!zone) return undefined;
  const blockers = troggBlockers(ctx, zoneId, now);
  const bounds = zoneBounds(zone, (tx, ty) => blockers.has(tileKey(tx, ty)));
  for (const p of ctx.db.player.zoneId.filter(zoneId)) {
    if (!p.online || p.dead) continue;
    if (exclude && p.identity.isEqual(exclude)) continue;
    const pos = projectMotion(p, elapsedMs(p.movedAt, now), bounds);
    if (Math.round(pos.x) === x && Math.round(pos.y) === y) return p;
  }
  return undefined;
}

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

/** Adjacent pickup candidates, with the faced tile first when the client has a heading. */
export function pickupDirs(dir: { dirX: number; dirY: number } | null): { dirX: number; dirY: number }[] {
  if (!dir) return [];
  if (dir.dirX === 0 && dir.dirY === 0) return [...CARDINALS];
  return [dir, ...CARDINALS.filter((d) => d.dirX !== dir.dirX || d.dirY !== dir.dirY)];
}

/** The adjacent target `interact` should pick up, preferring the faced direction. */
export function pickupTarget(ctx: Ctx, zoneId: string, x: number, y: number, dir: { dirX: number; dirY: number } | null, now: Stamp) {
  for (const d of pickupDirs(dir)) {
    const tx = x + d.dirX;
    const ty = y + d.dirY;
    const item = groundItemAt(ctx, zoneId, tx, ty);
    if (item) return { kind: "item" as const, row: item };
    const b = boulderAt(ctx, zoneId, tx, ty);
    if (b) return { kind: "boulder" as const, row: b };
    const h = hogAt(ctx, zoneId, tx, ty, now);
    if (h) return { kind: "hog" as const, row: h };
  }
  return undefined;
}

/** A Hog row's display style. Empty preserves existing id-derived rows; non-empty
 *  is used for Hogs that were carried and put down again. */
export function effectiveHogStyle(h: { id: bigint; style?: string }): string {
  return hogStyleFor(h.id.toString(), h.style);
}

/**
 * Drop a carried entity (GDD "Interacting") onto the faced tile, or the nearest
 * free neighbour, then the trogg's own tile (`spawnTile`) — so a boulder never
 * lands in a wall or on another boulder. Returns false if every candidate is
 * blocked, leaving the trogg still carrying it. `x`/`y` are the trogg's settled
 * tile; `dirX`/`dirY` its facing (0,0 = no faced tile, take a neighbour).
 */
export function placeCarried(
  ctx: Ctx,
  zone: Zone,
  kind: string,
  style: string,
  occupied: Set<string>,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
): boolean {
  const tile = spawnTile(zone, (tx, ty) => occupied.has(tileKey(tx, ty)), x, y, dirX, dirY);
  if (!tile) return false;
  return placeCarriedAt(ctx, zone, kind, style, tile);
}

/** Materialise a carried entity on an exact tile, enforcing the same caps as put-down. */
export function placeCarriedAt(ctx: Ctx, zone: Zone, kind: string, style: string, tile: { x: number; y: number }): boolean {
  // Honour the per-zone cap on the put-down too, so picking up, spawning to the cap, then
  // dropping can't push a zone past its ceiling. Refusing keeps the trogg carrying — the
  // same outcome as a boxed-in drop — so nothing is lost.
  if (kind === "boulder") {
    if (countRows(ctx.db.boulder.zoneId.filter(zone.slug)) >= MAX_BOULDERS_PER_ZONE) return false;
    ctx.db.boulder.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y });
  } else if (kind === "hog") {
    if (countRows(ctx.db.hog.zoneId.filter(zone.slug)) >= MAX_HOGS_PER_ZONE) return false;
    ctx.db.hog.insert({ id: 0n, zoneId: zone.slug, x: tile.x, y: tile.y, dirX: 0, dirY: 0, movedAt: ctx.timestamp, path: "", homeX: tile.x, homeY: tile.y, style, health: HOG_MAX_HEALTH });
  } else {
    return false;
  }
  return true;
}

/** The direction a trogg visually faces: current motion while moving, standing facing otherwise. */
export function facingDir(p: { dirX: number; dirY: number; faceX: number; faceY: number }): { dirX: number; dirY: number } {
  if (p.dirX !== 0 || p.dirY !== 0) return { dirX: p.dirX, dirY: p.dirY };
  return { dirX: p.faceX, dirY: p.faceY };
}

/** Coerce an untrusted axis input to -1, 0, or 1. */
export function unitStep(value: number): number {
  return value === -1 || value === 1 ? value : 0;
}

/**
 * Resolve an untrusted (dirX, dirY) to a cardinal intent: idle, or one axis of
 * unit length. A diagonal (both axes set) is invalid — movement is 4-directional
 * — and returns null so the caller can reject it.
 */
export function cardinal(dirX: number, dirY: number): { dirX: number; dirY: number } | null {
  const x = unitStep(dirX);
  const y = unitStep(dirY);
  if (x !== 0 && y !== 0) return null;
  return { dirX: x, dirY: y };
}
