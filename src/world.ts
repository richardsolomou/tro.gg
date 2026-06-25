import { Application, Container, FederatedPointerEvent, Graphics, Rectangle } from "pixi.js";
import { facingTile, getZone, parsePath, projectMotion, projectMotionState, snapToTile, STARTING_ZONE_SLUG, tileKey, timestampMs, troggColorFor, zoneBounds, type Coord, type ProjectedMotion, type Stamp, type Zone } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Boulder, Hog, Player } from "./module_bindings/types";
import { attachKeyboard, type MoveIntent } from "./input.js";
import { setupChat } from "./chat.js";
import { ART, createEntities, GHOST_CHANCE, type BoulderView, type HogView, type Tracked } from "./entities.js";
import { mountHelp } from "./help.js";
import { createTerrain } from "./terrain.js";
import { facingFromDir } from "./avatars.js";
import { captureEvent, isFeatureEnabled } from "./analytics.js";
import { audio } from "./audio.js";

/** Fraction of the viewport the zone fills, leaving a rim of cave around it. */
const ZONE_FILL = 0.92;
/** Screen pixels per tile, sized to the viewport in `layout`. */
let TILE = 28;

/** How long a new direction must be held before the trogg walks rather than just
 *  turning in place — the tap-vs-hold window (GDD "Movement"). Tune for feel. */
const TURN_TAP_MS = 130;

/** Min gap between click-to-move route (re)issues while a path is blocked or no route
 *  exists yet, so re-routing around a Hog — or waiting for one to clear the only way —
 *  retries steadily without firing the reducer every frame. */
const MOVETO_RETRY_MS = 250;

interface MotionSnapshot extends MoveIntent {
  x: number;
  y: number;
  path: string;
}

const sameIntent = (a: MoveIntent, b: MoveIntent) => a.dirX === b.dirX && a.dirY === b.dirY;
const sameMoveIntent = (a: MoveIntent, b: MoveIntent) => sameIntent(a, b) && a.running === b.running;
const isIdle = (i: MoveIntent) => i.dirX === 0 && i.dirY === 0;
const motionTol = 1e-6;

function timestampBaseMs(movedAt: Stamp): number {
  const elapsedMs = Math.max(0, Date.now() - timestampMs(movedAt));
  return performance.now() - elapsedMs;
}

function playerIntent(p: Pick<Player, "dirX" | "dirY" | "running">): MoveIntent {
  return { dirX: p.dirX, dirY: p.dirY, running: p.running };
}

function playerMotion(p: Pick<Player, "x" | "y" | "dirX" | "dirY" | "running" | "path">): MotionSnapshot {
  return { x: p.x, y: p.y, dirX: p.dirX, dirY: p.dirY, running: p.running, path: p.path };
}

function sameMotion(a: MotionSnapshot, b: MotionSnapshot): boolean {
  return (
    Math.abs(a.x - b.x) < motionTol &&
    Math.abs(a.y - b.y) < motionTol &&
    sameMoveIntent(a, b) &&
    a.path === b.path
  );
}

function withMotion(p: Player, motion: MotionSnapshot): Player {
  return { ...p, x: motion.x, y: motion.y, dirX: motion.dirX, dirY: motion.dirY, running: motion.running, path: motion.path };
}

/**
 * Has the trogg reached a tile centre on the axis it's moving along, since the last
 * frame? True when it lands on one (within float slack — also covers a trogg parked
 * flush against a wall) or crosses one between frames (moving at speed, a centre can
 * fall between two frames). `prev` is NaN on the first frame of a motion, where the
 * origin is already a centre, so treat that as reached.
 */
function reachedCentre(intent: MoveIntent, prevX: number, prevY: number, x: number, y: number): boolean {
  const prev = intent.dirX !== 0 ? prevX : prevY;
  const cur = intent.dirX !== 0 ? x : y;
  const step = intent.dirX !== 0 ? Math.sign(intent.dirX) : Math.sign(intent.dirY);
  if (Number.isNaN(prev)) return true;
  if (Math.abs(cur - Math.round(cur)) < 1e-3) return true;
  return step > 0 ? Math.floor(prev) !== Math.floor(cur) : Math.ceil(prev) !== Math.ceil(cur);
}

/**
 * Renders the zone: a tile grid plus a marker per player. Movement is intent-
 * based (GDD "Movement") — the `player` table syncs each trogg's origin,
 * direction, and start time, and every client extrapolates position locally each
 * frame so motion is smooth without per-frame server sync (invariant 2). Zone
 * dimensions come from the static `ZONES` registry (shared by client and module).
 * PixiJS is the renderer per the GDD "Camera and rendering" section.
 */
export function mountWorld(app: Application, conn: DbConnection) {
  const slug = STARTING_ZONE_SLUG;
  const zone = getZone(slug)!;
  const myId = conn.identity?.toHexString();
  // Avatar/scenery builders, sized off the live `TILE` (which `layout` resizes).
  const entities = createEntities(() => TILE);
  // Sprite avatars replace the placeholder marker behind an optional kill-switch;
  // the fallback is the colour marker.
  const useSprites = isFeatureEnabled("avatar-sprites");
  // Ambient roaming Hogs render behind their optional kill-switch.
  const useHogs = isFeatureEnabled("roaming-hogs");
  // Hold-shift-to-run has an optional rollout flag; off → shift is ignored and
  // movement stays at walk speed.
  const canRun = isFeatureEnabled("running");
  // The interact key (E) — pick up / put down tile-sized objects — behind its
  // optional kill-switch; off → E does nothing.
  const useInteract = isFeatureEnabled("interact");

  // Tiles boulders occupy, and tiles Hogs occupy (rebuilt each frame from their
  // projected positions — Hogs move, so their tiles shift between row updates).
  // Troggs are solid against boulders *and* Hogs (`troggBounds`); Hogs are rendered
  // against walls + boulders only (`hogBounds`), since the server already chose each
  // Hog's one-tile step clear of troggs and other Hogs (GDD "Hogs"). Troggs never
  // collide with each other, so player tiles are in neither set. The same builders
  // run server-side, so prediction confines entities to the same tiles authority does.
  const boulderTiles = new Set<string>();
  const hogTiles = new Set<string>();
  const hogBounds = zoneBounds(zone, (x, y) => boulderTiles.has(tileKey(x, y)));
  const troggBounds = zoneBounds(zone, (x, y) => boulderTiles.has(tileKey(x, y)) || hogTiles.has(tileKey(x, y)));

  const terrain = createTerrain(zone);
  const stage = new Container();
  // Background rock fills the screen behind the zone; the stage carries the floor
  // + walls + boulders + markers and is centred; the vignette darkens edges on top.
  app.stage.addChild(terrain.background, stage, terrain.vignette);
  stage.addChild(terrain.ground);
  const destinationLayer = new Container();
  const boulderLayer = new Container();
  const hogLayer = new Container();
  const clickLayer = new Graphics();
  clickLayer.eventMode = "static";
  stage.addChild(destinationLayer, boulderLayer, hogLayer, clickLayer);

  const tracked = new Map<string, Tracked>();
  const boulders = new Map<string, BoulderView>();
  const hogs = new Map<string, HogView>();
  const pendingSelfMoves: MotionSnapshot[] = [];
  let destinationTile: Coord | undefined;
  let destinationPath = "";
  // Subscription bootstrap guard. Row handlers can receive the initial snapshot;
  // sounds should only fire for live gameplay diffs after that snapshot is applied.
  const sub = { live: false };

  const drawDestination = () => {
    destinationLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
    if (!destinationTile) return;
    const px = Math.max(1, Math.round(TILE / ART));
    const inset = Math.max(2, Math.round(TILE * 0.1));
    const marker = new Graphics()
      .rect(inset, inset, TILE - inset * 2, TILE - inset * 2)
      .fill(0xe8dcc4)
      .rect(inset, inset, TILE - inset * 2, TILE - inset * 2)
      .stroke({ width: px * 2, color: 0xf2c94c, alignment: 0 });
    marker.alpha = 0.28;
    entities.place(marker, destinationTile.x, destinationTile.y);
    destinationLayer.addChild(marker);
  };

  const setDestination = (tile: Coord | undefined) => {
    destinationTile = tile;
    drawDestination();
  };

  const syncDestinationFromPath = (path: string) => {
    if (path === "") {
      // Keep the marker. An empty path can mean "no route right now" — a Hog has sealed
      // the only way — and we keep trying toward the clicked tile rather than abandoning
      // it. The marker clears on arrival, on a keypress, or when a new tile is clicked.
      destinationPath = "";
      return;
    }
    if (path === destinationPath) return;
    destinationPath = path;
    // Keep the marker on the tile you clicked, not the route's (possibly truncated) end.
    // A Hog taking the target tile — or one near it — before you arrive shouldn't drag
    // where you pointed to a different tile; the re-route also aims at the clicked tile
    // (`destinationTile`), not the truncated end, so the destination can't drift. We
    // only adopt the route's end when there's no marker yet (resuming after a reconnect).
    if (!destinationTile) setDestination(parsePath(path).at(-1));
  };

  const clearDestination = () => {
    destinationTile = undefined;
    drawDestination();
  };

  const layout = () => {
    const { width: vw, height: vh } = app.renderer;
    const fit = Math.min((vw * ZONE_FILL) / zone.width, (vh * ZONE_FILL) / zone.height);
    TILE = Math.max(ART, Math.floor(fit));
    terrain.layout(TILE, vw, vh);
    clickLayer.clear();
    clickLayer.hitArea = new Rectangle(0, 0, zone.width * TILE, zone.height * TILE);
    drawDestination();
    entities.centre(app, stage, zone.width, zone.height);
    // Markers and boulder sprites bake TILE into their size, so resize redraws them.
    for (const [id, entry] of tracked) rebuildMarker(id, entry);
    for (const view of boulders.values()) {
      view.sprite.destroy({ children: true });
      view.sprite = entities.makeBoulder();
      entities.place(view.sprite, view.row.x, view.row.y);
      boulderLayer.addChild(view.sprite);
    }
    // Hog sprites bake TILE into their scale too; the ticker repositions them next frame.
    for (const view of hogs.values()) {
      view.marker.destroy({ children: true });
      const built = entities.makeHog(view.facing);
      view.marker = built.marker;
      view.sprite = built.sprite;
      view.frameKey = built.frameKey;
      entities.place(view.marker, view.row.x, view.row.y);
      hogLayer.addChild(view.marker);
    }
  };

  const rebuildMarker = (id: string, entry: Tracked) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.marker.destroy({ children: true });
    const built = entities.makeMarker(entry.player.name, troggColorFor(entry.player.color, id), id === myId, entry.facing, useSprites);
    entry.marker = built.marker;
    entry.sprite = built.sprite;
    entry.frameKey = built.frameKey;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    // The carried overlay was a child of the old marker, so it's gone too; re-add it.
    entry.carried = undefined;
    entry.carriedKind = "";
    const { x, y } = projectMotion(entry.player, performance.now() - entry.baseMs, troggBounds);
    entities.place(entry.marker, x, y);
    stage.addChild(entry.marker);
    entities.applyCarry(entry);
  };

  app.renderer.on("resize", layout);
  layout();

  const addPlayer = (p: Player) => {
    const id = p.identity.toHexString();
    if (tracked.has(id)) return;
    const facing = facingFromDir(p.dirX, p.dirY, "down");
    const { marker, sprite, frameKey } = entities.makeMarker(p.name, troggColorFor(p.color, id), id === myId, facing, useSprites);
    const entry: Tracked = { marker, sprite, player: p, baseMs: timestampBaseMs(p.movedAt), facing, frameKey, carriedKind: "" };
    const { x, y } = projectMotion(p, performance.now() - entry.baseMs, troggBounds);
    entities.place(marker, x, y);
    tracked.set(id, entry);
    stage.addChild(marker);
    entities.applyCarry(entry);
  };

  const removePlayer = (id: string) => {
    const entry = tracked.get(id);
    if (entry?.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry?.marker.destroy({ children: true });
    tracked.delete(id);
  };

  conn.db.player.onInsert((_ctx, p) => addPlayer(p));
  conn.db.player.onUpdate((_ctx, _old, p) => {
    const id = p.identity.toHexString();
    const entry = tracked.get(id);
    if (!entry) return addPlayer(p);

    if (id === myId) {
      const serverMotion = playerMotion(p);
      const pendingIndex = pendingSelfMoves.findIndex((motion) => sameMotion(motion, serverMotion));
      if (pendingIndex >= 0) {
        pendingSelfMoves.splice(0, pendingIndex + 1);
        entry.player = withMotion(p, playerMotion(entry.player));
      } else if (sameMotion(playerMotion(entry.player), serverMotion)) {
        entry.player = withMotion(p, playerMotion(entry.player));
      } else {
        pendingSelfMoves.length = 0;
        entry.player = p;
        entry.baseMs = timestampBaseMs(p.movedAt);
        sent = playerIntent(p);
        prevX = Number.NaN;
        prevY = Number.NaN;
        pushBlocked = false;
      }
      syncDestinationFromPath(p.path);
    } else {
      // Rebase extrapolation to the server's `movedAt` on the local monotonic clock,
      // not receipt time, so a deployed client doesn't trail the server by its network
      // latency (which would show as correction jitter).
      entry.player = p;
      entry.baseMs = timestampBaseMs(p.movedAt);
    }

    // The nameplate and tint are baked into the marker at build time, so a rename
    // or recolour only shows once the marker is rebuilt from the updated row (which
    // also re-applies the carried overlay). A bare carrying change just retargets
    // the overlay.
    if (_old.name !== p.name || _old.color !== p.color) rebuildMarker(id, entry);
    else if (_old.carrying !== p.carrying) entities.applyCarry(entry);

    // Pick-up / put-down are low-volume, so emit on the authoritative carrying
    // transition of your own trogg (GDD analytics: observe server truth).
    if (id === myId && _old.carrying !== p.carrying) {
      captureEvent(p.carrying ? "object_picked_up" : "object_dropped", { zone: slug, kind: p.carrying || _old.carrying });
    }
  });
  conn.db.player.onDelete((_ctx, p) => removePlayer(p.identity.toHexString()));

  const syncBoulderTiles = () => {
    boulderTiles.clear();
    for (const view of boulders.values()) boulderTiles.add(tileKey(view.row.x, view.row.y));
  };
  const upsertBoulder = (b: Boulder) => {
    const key = b.id.toString();
    let view = boulders.get(key);
    if (!view) {
      view = { row: b, sprite: entities.makeBoulder() };
      boulders.set(key, view);
      boulderLayer.addChild(view.sprite);
    } else {
      view.row = b;
    }
    entities.place(view.sprite, b.x, b.y);
    syncBoulderTiles();
  };
  const removeBoulder = (b: Boulder) => {
    const view = boulders.get(b.id.toString());
    view?.sprite.destroy({ children: true });
    boulders.delete(b.id.toString());
    syncBoulderTiles();
  };

  conn.db.boulder.onInsert((_ctx, b) => upsertBoulder(b));
  conn.db.boulder.onUpdate((_ctx, _old, b) => {
    if (sub.live && (_old.x !== b.x || _old.y !== b.y)) audio.playBoulderSettle();
    upsertBoulder(b);
  });
  conn.db.boulder.onDelete((_ctx, b) => removeBoulder(b));

  const addHog = (h: Hog) => {
    const id = h.id.toString();
    if (hogs.has(id)) return;
    const facing = facingFromDir(h.dirX, h.dirY, "down");
    const { marker, sprite, frameKey } = entities.makeHog(facing);
    const baseMs = timestampBaseMs(h.movedAt);
    const { x, y } = projectMotion(h, performance.now() - baseMs, hogBounds);
    entities.place(marker, x, y);
    hogs.set(id, { marker, sprite, row: h, baseMs, facing, frameKey });
    hogLayer.addChild(marker);
  };
  const updateHog = (h: Hog) => {
    const view = hogs.get(h.id.toString());
    if (!view) return addHog(h);
    // Rebase extrapolation on each new intent, like remote players.
    view.row = h;
    view.baseMs = timestampBaseMs(h.movedAt);
  };
  const removeHog = (h: Hog) => {
    const view = hogs.get(h.id.toString());
    view?.marker.destroy({ children: true });
    hogs.delete(h.id.toString());
  };

  // Roaming Hogs render behind their optional kill-switch.
  if (useHogs) {
    conn.db.hog.onInsert((_ctx, h) => addHog(h));
    conn.db.hog.onUpdate((_ctx, _old, h) => {
      updateHog(h);
      if (!sub.live) return;
      const changedHeading = _old.dirX !== h.dirX || _old.dirY !== h.dirY;
      if (changedHeading && Math.random() < 0.35) audio.playHog();
    });
    conn.db.hog.onDelete((_ctx, h) => removeHog(h));
  }

  const pushEnabled = isFeatureEnabled("boulder-pushing");

  // My-trogg movement is grid-locked (GDD "Movement", Pokémon/Zelda style): the
  // `move` reducer fires only when the trogg sits on a tile centre, so a step always
  // finishes before it turns or stops. We optimistically apply our own sent intent
  // to display state, then treat the matching server row as an ack instead of
  // restarting the animation from receipt time. Server rows that don't match a
  // pending prediction still win and snap the display back to authority.
  // `desired` is what the keys want now; `sent` is the committed display intent
  // (idle = stopped); `facing` is the way the trogg points (sprite only — set even
  // while standing still). `prevX`/`prevY` are last frame's predicted position, so
  // we can spot the moving axis crossing a centre.
  let desired: MoveIntent = { dirX: 0, dirY: 0, running: false };
  let lastDesired: MoveIntent = { dirX: 0, dirY: 0, running: false };
  let sent: MoveIntent = { dirX: 0, dirY: 0, running: false };
  let facing: MoveIntent = { dirX: 0, dirY: 1, running: false };
  let prevX = Number.NaN;
  let prevY = Number.NaN;
  // A fresh press into a new direction turns the trogg in place; it only starts
  // walking if the key is still held past this beat — so a tap turns, a hold walks
  // (Pokémon-style). Gates that one hold; pressing the faced direction walks at once.
  let walkAfter = Number.POSITIVE_INFINITY;
  // Whether we were flush against a pushable boulder last frame, so `push` fires once
  // per tile (on the rising edge), not every frame.
  let pushBlocked = false;
  // When we last (re)issued a click-to-move route, so re-routing a blocked path — or
  // retrying when no route exists yet — is throttled (`MOVETO_RETRY_MS`) instead of
  // fired every frame.
  let lastMoveToAt = 0;
  let lastFootstepTile = "";
  // The tile our motion origin currently sits on. A straight run re-bases the origin to
  // each tile centre it crosses (`driveSelf`), so position is only ever derived over the
  // last tile — a Hog wandering onto a tile we've already passed is behind the origin and
  // can't rewind us (the WASD analogue of forward-only path projection). Dedupes the
  // per-tile re-base so it fires once per crossing, not every frame.
  let lastRebaseTile = "";
  // A click-to-move target waiting for the trogg to reach a tile centre before it
  // re-paths. Click-to-move is grid-locked like WASD (GDD "Movement"): re-basing
  // the path mid-step would let the server snap the trogg's fractional position
  // forward to the nearest tile for free, so double-clicking would bank sub-tile
  // distance and visibly speed the trogg up for everyone. Holding the click until
  // the next centre keeps every re-path on a whole tile, so the snap is a no-op;
  // repeated clicks just overwrite this target and resolve to one clean route.
  let pendingMoveTo: Coord | null = null;

  const sendMove = (entry: Tracked, intent: MoveIntent, x: number, y: number, now: number) => {
    const origin = snapToTile({ x, y });
    const motion: MotionSnapshot = { ...intent, x: origin.x, y: origin.y, path: "" };
    const wasIdle = isIdle(sent);
    sent = intent;
    pendingSelfMoves.push(motion);
    entry.player = withMotion(entry.player, motion);
    entry.baseMs = now;
    prevX = Number.NaN;
    prevY = Number.NaN;
    lastFootstepTile = tileKey(origin.x, origin.y);
    lastRebaseTile = tileKey(origin.x, origin.y);
    if (!isIdle(intent)) {
      facing = intent;
      entry.facing = facingFromDir(intent.dirX, intent.dirY, entry.facing);
      if (wasIdle) audio.playFootstep(intent.running);
    }
    conn.reducers.move(intent);
  };

  const playFootstepAtCentre = (x: number, y: number, intent: MoveIntent) => {
    if (isIdle(intent) || Number.isNaN(prevX) || !reachedCentre(intent, prevX, prevY, x, y)) return;
    const tile = snapToTile({ x, y });
    const key = tileKey(tile.x, tile.y);
    if (key === lastFootstepTile) return;
    lastFootstepTile = key;
    audio.playFootstep(intent.running);
  };

  // Push (GDD "Pushing", gated by its optional flag) fires while the trogg is
  // *actively walking into* a boulder: the key is still held (`desired`) in the
  // committed direction (`sent`, so a tap-to-turn never shoves) and it faces a
  // boulder it's squarely on a centre against. Requiring the key still be held is
  // what stops a mere approach from pushing — let go and `desired` goes idle at
  // once, so coasting the last fraction of a tile to a stop beside a boulder never
  // shoves it. Edge-triggered, so holding into a boulder slides it one tile per tile
  // as the trogg catches up (cadence falls out of walk speed). The server
  // re-validates and re-bases motion (invariant 3).
  const pushStep = (x: number, y: number) => {
    const into = pushEnabled && !isIdle(sent) && sameIntent(desired, sent);
    const ahead = into ? facingTile(x, y, sent.dirX, sent.dirY) : null;
    const intoBoulder = ahead != null && boulderTiles.has(tileKey(ahead.x, ahead.y));
    if (intoBoulder && !pushBlocked) {
      audio.playBoulderPush();
      conn.reducers.push({});
    }
    pushBlocked = intoBoulder;
  };

  const turn = (entry: Tracked, now: number) => {
    facing = desired;
    entry.facing = facingFromDir(desired.dirX, desired.dirY, entry.facing);
    walkAfter = now + TURN_TAP_MS;
  };

  // Is a Hog flush on the tile directly ahead in `dir`? `facingTile` returns that tile
  // only when we're squarely on a centre (within tol), so a trogg still sliding mid-tile
  // never reads as blocked. Hogs are the moving obstacle a trogg stops against; boulders
  // are handled by `push` (which re-bases each shove, so its intent never goes stale) and
  // walls never move, so neither needs the stop-and-resume below.
  const blockedByHog = (x: number, y: number, dir: MoveIntent) => {
    if (isIdle(dir)) return false;
    const ahead = facingTile(x, y, dir.dirX, dir.dirY);
    return ahead != null && hogTiles.has(tileKey(ahead.x, ahead.y));
  };

  const driveSelf = (entry: Tracked, x: number, y: number, now: number) => {
    const fresh = !sameIntent(desired, lastDesired);
    lastDesired = desired;
    const pathing = entry.player.path !== "";

    if (pathing) {
      if (isIdle(desired)) return;
      const pathIntent = { dirX: entry.player.dirX, dirY: entry.player.dirY, running: entry.player.running };
      if (!reachedCentre(pathIntent, prevX, prevY, x, y)) return;
      sendMove(entry, desired, x, y, now);
      if (!isIdle(desired)) facing = desired;
      return;
    }

    if (!isIdle(sent)) {
      // Walking: change direction, speed (shift→run), or stop at the next tile centre
      // (grid-lock). A new direction mid-walk corners fluidly — no turn-in-place beat.
      const keepGoing = sameIntent(desired, sent) && desired.running === sent.running;
      if (keepGoing && !blockedByHog(x, y, sent)) {
        // Running straight on. Re-base the origin to each tile centre we cross so position
        // is only ever derived over the last tile: a Hog stepping onto a tile we've already
        // passed sits behind the origin and can no longer rewind us (stateless re-derivation
        // from a stale origin would otherwise yank us flush against it). The tile-key guard
        // keeps this to one re-base per crossing — `reachedCentre`'s 1e-3 slack can read true
        // on two adjacent frames straddling the same centre, which would re-base it twice.
        const tile = snapToTile({ x, y });
        const key = tileKey(tile.x, tile.y);
        if (key !== lastRebaseTile && reachedCentre(sent, prevX, prevY, x, y)) sendMove(entry, sent, x, y, now);
        return;
      }
      if (!reachedCentre(sent, prevX, prevY, x, y)) return;
      if (keepGoing) {
        // Flush against a Hog while still holding this way. Stop here instead of keeping
        // a walking intent that goes stale: a held intent banks elapsed travel against
        // the Hog, and the moment the Hog ambles off the server re-derives the position
        // from that stale origin with nothing left to clamp it — flinging the trogg to
        // where the uninterrupted walk would have reached. An idle intent can't overshoot.
        // We resume below the instant the tile frees (`desired` still holds the way).
        sendMove(entry, { dirX: 0, dirY: 0, running: sent.running }, x, y, now);
        facing = sent;
        entry.facing = facingFromDir(sent.dirX, sent.dirY, entry.facing);
        return;
      }
      sendMove(entry, desired, x, y, now);
      if (!isIdle(desired)) facing = desired;
      return;
    }

    // Stopped (on a tile centre).
    if (isIdle(desired)) {
      walkAfter = Number.POSITIVE_INFINITY;
      return;
    }
    if (blockedByHog(x, y, desired)) {
      // Want to go, but a Hog is flush ahead. Wait facing it — no stale walking intent to
      // overshoot — and keep `walkAfter` in the past so the frame it clears we walk at
      // once (no turn-in-place beat: we were already committed to this direction).
      facing = desired;
      entry.facing = facingFromDir(desired.dirX, desired.dirY, entry.facing);
      walkAfter = now;
      return;
    }
    if (fresh) {
      // Press the way we already face → walk at once; a new direction → turn in place.
      if (sameIntent(desired, facing)) sendMove(entry, desired, x, y, now);
      else turn(entry, now);
      return;
    }
    // Holding the faced direction past the turn beat → start walking.
    if (sameIntent(desired, facing) && now >= walkAfter) {
      walkAfter = Number.POSITIVE_INFINITY;
      sendMove(entry, desired, x, y, now);
    }
  };

  // Fire a pending click-to-move once the trogg sits on a tile centre, so a step
  // always completes before it re-paths (GDD "Movement" grid-lock) — the same beat
  // `driveSelf` waits for to turn or stop under WASD. An idle trogg is already
  // centred and routes at once; a moving one finishes its current step first. The
  // server then settles onto that whole tile (a no-op snap), so no sub-tile distance
  // is banked no matter how fast the clicks come.
  const flushPendingMoveTo = (entry: Tracked, motion: ProjectedMotion, x: number, y: number, now: number) => {
    if (!pendingMoveTo) return;
    const dir = { dirX: motion.dirX, dirY: motion.dirY, running: entry.player.running };
    if (!isIdle(dir) && !reachedCentre(dir, prevX, prevY, x, y)) return;
    const target = pendingMoveTo;
    pendingMoveTo = null;
    sent = { dirX: 0, dirY: 0, running: false };
    pendingSelfMoves.length = 0;
    lastMoveToAt = now;
    conn.reducers.moveTo({ x: target.x, y: target.y, running: false });
  };

  app.ticker.add(() => {
    const now = performance.now();

    // Hogs first: derive each Hog's position (intent extrapolation, never per-frame
    // sync — invariant 2) and rebuild the Hog tile set so trogg collision this frame
    // sees where the Hogs actually are. Hogs collide against walls and boulders only;
    // the server already kept their one-tile step clear of troggs and other Hogs.
    hogTiles.clear();
    for (const view of hogs.values()) {
      const motion = projectMotionState(view.row, now - view.baseMs, hogBounds);
      entities.place(view.marker, motion.x, motion.y);
      entities.driveSprite(view.sprite, "hog", motion.dirX, motion.dirY, false, view, now);
      const tile = snapToTile({ x: motion.x, y: motion.y });
      hogTiles.add(tileKey(tile.x, tile.y));
    }

    for (const entry of tracked.values()) {
      const motion = projectMotionState(entry.player, now - entry.baseMs, troggBounds);
      const { x, y } = motion;
      entities.place(entry.marker, x, y);
      entities.animate(entry, now, motion);

      if (entry.player.identity.toHexString() !== myId) continue;

      playFootstepAtCentre(x, y, { dirX: motion.dirX, dirY: motion.dirY, running: entry.player.running });
      // A click-to-move route stalls when a Hog (or a shoved boulder) lands on a tile
      // ahead of it: `projectPathMotion` stops with no heading and `arrived` false.
      const stalled = entry.player.path !== "" && !motion.arrived && motion.dirX === 0 && motion.dirY === 0;
      if (!pendingMoveTo && motion.arrived && entry.player.path !== "") clearDestination();
      if (pendingMoveTo) {
        flushPendingMoveTo(entry, motion, x, y, now);
      } else if (destinationTile && isIdle(desired) && (stalled || entry.player.path === "")) {
        // Heading for the clicked tile but not making progress: the route stalled on a Hog
        // ahead, or there's no route at all right now (a Hog has sealed the only way). Re-issue
        // the route to the clicked tile — bending around Hogs, or just waiting and retrying
        // until a way opens — rather than giving up halfway. Throttled (`MOVETO_RETRY_MS`) so
        // it isn't fired every frame; a keypress falls through to `driveSelf` (WASD takes over).
        if (now - lastMoveToAt >= MOVETO_RETRY_MS) {
          lastMoveToAt = now;
          conn.reducers.moveTo({ x: destinationTile.x, y: destinationTile.y, running: false });
        }
      } else {
        driveSelf(entry, x, y, now);
      }
      pushStep(x, y);
      prevX = x;
      prevY = y;
    }
  });

  attachKeyboard((intent, immediate) => {
    desired = intent;
    destinationPath = "";
    // A keypress takes over from click-to-move: drop any click waiting for a centre.
    pendingMoveTo = null;
    clearDestination();
    // Focus loss: stop now instead of finishing the step — a backgrounded tab's
    // ticker is frozen, so a buffered stop would never flush and the trogg would
    // keep sliding until it hit a wall. The server settles it onto a whole tile.
    if (immediate) {
      const now = performance.now();
      const self = myId ? tracked.get(myId) : undefined;
      walkAfter = Number.POSITIVE_INFINITY;
      if (self) {
        const { x, y } = projectMotion(self.player, now - self.baseMs, troggBounds);
        sendMove(self, intent, x, y, now);
      } else {
        sent = intent;
        conn.reducers.move(intent);
      }
    }
  }, () => {
    // Interact with the faced tile (GDD "Interacting"): pick up / put down. The
    // server has no synced standing facing, so pass the trogg's current heading;
    // it re-derives the tile and acts only on what's actually adjacent (invariant 3).
    if (!useInteract) return;
    conn.reducers.interact({ dirX: facing.dirX, dirY: facing.dirY });
  }, canRun);

  clickLayer.on("pointertap", (e: FederatedPointerEvent) => {
    const local = e.getLocalPosition(stage);
    const x = Math.floor(local.x / TILE);
    const y = Math.floor(local.y / TILE);
    if (x < 0 || y < 0 || x >= zone.width || y >= zone.height) return;
    desired = { dirX: 0, dirY: 0, running: false };
    lastDesired = desired;
    walkAfter = Number.POSITIVE_INFINITY;
    pushBlocked = false;
    destinationPath = "";
    // Show the target now, but hold the actual re-path until the trogg reaches a
    // tile centre (`flushPendingMoveTo`) — a flurry of clicks just overwrites the
    // target, so the trogg can never bank sub-tile distance between centres.
    pendingMoveTo = { x, y };
    setDestination({ x, y });
  });

  // Cosmetic join easter egg. Each launch has a chance of a haunt at the origin.
  if (isFeatureEnabled("ghost-trogg") && Math.random() < GHOST_CHANCE) entities.hauntGhost(stage, { x: 0, y: 0 });

  // Live once the initial rows have been delivered: backlog chat fills the
  // history panel silently, while later inserts also pop a bubble.
  if (isFeatureEnabled("chat-enabled")) setupChat(app, conn, entities, tracked, zone, sub, myId, stage);

  // A standing reference of controls and chat commands so a fresh trogg knows what
  // it can do — listing only the features this session has enabled (GDD HUD note).
  mountHelp(app);

  const queries = [
    `SELECT * FROM player WHERE zone_id = '${slug}' AND online = true`,
    `SELECT * FROM chat_message WHERE zone_id = '${slug}'`,
    `SELECT * FROM boulder WHERE zone_id = '${slug}'`,
  ];
  if (useHogs) queries.push(`SELECT * FROM hog WHERE zone_id = '${slug}'`);

  conn
    .subscriptionBuilder()
    .onApplied(() => (sub.live = true))
    .subscribe(queries);
}

