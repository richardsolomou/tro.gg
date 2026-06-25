import { Application, Container, FederatedPointerEvent, Graphics, Rectangle, Sprite, Text } from "pixi.js";
import { ANCHOR, CHAT_BUBBLE_MS, COLOR_UNSET, facingTile, FRAME_H, FRAME_W, getZone, parsePath, projectMotion, projectMotionState, snapToTile, STARTING_ZONE_SLUG, troggColorFor, zoneBounds, type Coord, type Facing, type Kind, type ProjectedMotion, type Zone } from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Boulder, Hog, Player } from "./module_bindings/types";
import { attachKeyboard, type MoveIntent } from "./input.js";
import { mountChat, type ChatUI } from "./chat.js";
import { mountHelp } from "./help.js";
import { createTerrain } from "./terrain.js";
import { avatarFrame, avatarTexture, facingFromDir, ghostTexture } from "./avatars.js";
import { captureEvent, isFeatureEnabled } from "./analytics.js";
import { TEXT_RESOLUTION } from "./ui_text.js";
import { audio } from "./audio.js";

/** Art pixels per tile — terrain tiles are drawn at this and scaled up crisply. */
const ART = 16;
/** Fraction of the viewport the zone fills, leaving a rim of cave around it. */
const ZONE_FILL = 0.92;
/** Screen pixels per tile, sized to the viewport in `layout`. */
let TILE = 28;

/** How long a new direction must be held before the trogg walks rather than just
 *  turning in place — the tap-vs-hold window (GDD "Movement"). Tune for feel. */
const TURN_TAP_MS = 130;

/** Size of a carried object's overlay relative to a full tile (GDD "Interacting"). */
const CARRY_SCALE = 0.62;

/** A player's sprite plus the client-clock instant its current intent arrived. */
interface Tracked {
  marker: Container;
  /** The trogg sprite, or undefined when the `avatar-sprites` flag is off. */
  sprite?: Sprite;
  player: Player;
  baseMs: number;
  /** Last facing, kept so an idle trogg holds its heading rather than snapping. */
  facing: Facing;
  /** The frame key currently on the sprite, so the ticker only swaps on change. */
  frameKey: string;
  bubble?: Container;
  bubbleTimer?: ReturnType<typeof setTimeout>;
  /** The overlay sprite for what the trogg carries (GDD "Interacting"), if any. */
  carried?: Container;
  /** Which kind the overlay shows ("" = none), so it only rebuilds on change. */
  carriedKind: string;
}

type TimestampLike = { microsSinceUnixEpoch: bigint };

interface MotionSnapshot extends MoveIntent {
  x: number;
  y: number;
  path: string;
}

/**
 * Screen-space y of a trogg's feet within its tile cell, relative to the cell's
 * top-left (where `place` anchors the marker). The feet sit at the cell's vertical
 * centre so the trogg stands in the middle of its tile, not on the bottom-edge seam.
 */
function feetY(): number {
  return TILE / 2;
}

/** Screen-space y of the top of a trogg's head, for placing labels and bubbles. */
function headTopY(): number {
  return feetY() - FRAME_H * (TILE / ART);
}

/** A boulder's live row plus its sprite. */
interface BoulderView {
  row: Boulder;
  sprite: Container;
}

/** A roaming Hog's sprite plus the client-clock instant its current intent arrived. */
interface HogView {
  marker: Container;
  sprite: Sprite;
  row: Hog;
  baseMs: number;
  facing: Facing;
  frameKey: string;
}

/** "x,y" key for a tile, matching the server's occupancy keys. */
const tileKey = (x: number, y: number) => `${x},${y}`;

const sameIntent = (a: MoveIntent, b: MoveIntent) => a.dirX === b.dirX && a.dirY === b.dirY;
const sameMoveIntent = (a: MoveIntent, b: MoveIntent) => sameIntent(a, b) && a.running === b.running;
const isIdle = (i: MoveIntent) => i.dirX === 0 && i.dirY === 0;
const motionTol = 1e-6;

function timestampBaseMs(movedAt: TimestampLike): number {
  const movedAtMs = Number(movedAt.microsSinceUnixEpoch / 1000n);
  const elapsedMs = Math.max(0, Date.now() - movedAtMs);
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
    place(marker, destinationTile.x, destinationTile.y);
    destinationLayer.addChild(marker);
  };

  const setDestination = (tile: Coord | undefined) => {
    destinationTile = tile;
    drawDestination();
  };

  const syncDestinationFromPath = (path: string) => {
    if (path === "") {
      destinationPath = "";
      setDestination(undefined);
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
    centre(app, stage, zone.width, zone.height);
    // Markers and boulder sprites bake TILE into their size, so resize redraws them.
    for (const [id, entry] of tracked) rebuildMarker(id, entry);
    for (const view of boulders.values()) {
      view.sprite.destroy({ children: true });
      view.sprite = makeBoulder();
      place(view.sprite, view.row.x, view.row.y);
      boulderLayer.addChild(view.sprite);
    }
    // Hog sprites bake TILE into their scale too; the ticker repositions them next frame.
    for (const view of hogs.values()) {
      view.marker.destroy({ children: true });
      const built = makeHog(view.facing);
      view.marker = built.marker;
      view.sprite = built.sprite;
      view.frameKey = built.frameKey;
      place(view.marker, view.row.x, view.row.y);
      hogLayer.addChild(view.marker);
    }
  };

  const rebuildMarker = (id: string, entry: Tracked) => {
    if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
    entry.marker.destroy({ children: true });
    const built = makeMarker(entry.player.name, troggColorFor(entry.player.color, id), id === myId, entry.facing, useSprites);
    entry.marker = built.marker;
    entry.sprite = built.sprite;
    entry.frameKey = built.frameKey;
    entry.bubble = undefined;
    entry.bubbleTimer = undefined;
    // The carried overlay was a child of the old marker, so it's gone too; re-add it.
    entry.carried = undefined;
    entry.carriedKind = "";
    const { x, y } = projectMotion(entry.player, performance.now() - entry.baseMs, troggBounds);
    place(entry.marker, x, y);
    stage.addChild(entry.marker);
    applyCarry(entry);
  };

  app.renderer.on("resize", layout);
  layout();

  const addPlayer = (p: Player) => {
    const id = p.identity.toHexString();
    if (tracked.has(id)) return;
    const facing = facingFromDir(p.dirX, p.dirY, "down");
    const { marker, sprite, frameKey } = makeMarker(p.name, troggColorFor(p.color, id), id === myId, facing, useSprites);
    const entry: Tracked = { marker, sprite, player: p, baseMs: timestampBaseMs(p.movedAt), facing, frameKey, carriedKind: "" };
    const { x, y } = projectMotion(p, performance.now() - entry.baseMs, troggBounds);
    place(marker, x, y);
    tracked.set(id, entry);
    stage.addChild(marker);
    applyCarry(entry);
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
      // Rebase extrapolation to the server's `movedAt`, mapped onto the local
      // monotonic clock. Using receipt time here makes deployed clients trail the
      // server by their network latency, which shows up as correction jitter.
      entry.player = p;
      entry.baseMs = timestampBaseMs(p.movedAt);
    }

    // The nameplate and tint are baked into the marker at build time, so a rename
    // or recolour only shows once the marker is rebuilt from the updated row (which
    // also re-applies the carried overlay). A bare carrying change just retargets
    // the overlay.
    if (_old.name !== p.name || _old.color !== p.color) rebuildMarker(id, entry);
    else if (_old.carrying !== p.carrying) applyCarry(entry);

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
      view = { row: b, sprite: makeBoulder() };
      boulders.set(key, view);
      boulderLayer.addChild(view.sprite);
    } else {
      view.row = b;
    }
    place(view.sprite, b.x, b.y);
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
    const { marker, sprite, frameKey } = makeHog(facing);
    const baseMs = timestampBaseMs(h.movedAt);
    const { x, y } = projectMotion(h, performance.now() - baseMs, hogBounds);
    place(marker, x, y);
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
  // Whether we've already re-routed the current click-to-move stall, so a route blocked
  // by a Hog re-plans once (not every frame while the new route is in flight).
  let stallReplanned = false;
  let lastFootstepTile = "";
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
      if (keepGoing && !blockedByHog(x, y, sent)) return;
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
  const flushPendingMoveTo = (entry: Tracked, motion: ProjectedMotion, x: number, y: number) => {
    if (!pendingMoveTo) return;
    const dir = { dirX: motion.dirX, dirY: motion.dirY, running: entry.player.running };
    if (!isIdle(dir) && !reachedCentre(dir, prevX, prevY, x, y)) return;
    const target = pendingMoveTo;
    pendingMoveTo = null;
    sent = { dirX: 0, dirY: 0, running: false };
    pendingSelfMoves.length = 0;
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
      place(view.marker, motion.x, motion.y);
      driveSprite(view.sprite, "hog", motion.dirX, motion.dirY, false, view, now);
      const tile = snapToTile({ x: motion.x, y: motion.y });
      hogTiles.add(tileKey(tile.x, tile.y));
    }

    for (const entry of tracked.values()) {
      const motion = projectMotionState(entry.player, now - entry.baseMs, troggBounds);
      const { x, y } = motion;
      place(entry.marker, x, y);
      animate(entry, now, motion);

      if (entry.player.identity.toHexString() !== myId) continue;

      playFootstepAtCentre(x, y, { dirX: motion.dirX, dirY: motion.dirY, running: entry.player.running });
      // A click-to-move route stalls when a Hog (or a shoved boulder) lands on a tile
      // ahead of it: `projectPathMotion` stops with no heading and `arrived` false.
      const stalled = entry.player.path !== "" && !motion.arrived && motion.dirX === 0 && motion.dirY === 0;
      if (!stalled) stallReplanned = false;
      if (!pendingMoveTo && motion.arrived && entry.player.path !== "") clearDestination();
      if (pendingMoveTo) {
        flushPendingMoveTo(entry, motion, x, y);
      } else if (stalled && isIdle(desired) && destinationTile) {
        // Re-route around the obstacle to the same destination rather than stopping:
        // `moveTo` re-settles to this stall tile (a whole tile, so nothing is banked)
        // and runs findPath fresh against where the Hogs are now, so the trogg walks
        // around. Once per stall; a keypress falls through to `driveSelf` (WASD takes over).
        if (!stallReplanned) {
          stallReplanned = true;
          conn.reducers.moveTo({ x: destinationTile.x, y: destinationTile.y, running: entry.player.running });
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
  if (isFeatureEnabled("ghost-trogg") && Math.random() < GHOST_CHANCE) hauntGhost(stage, { x: 0, y: 0 });

  // Live once the initial rows have been delivered: backlog chat fills the
  // history panel silently, while later inserts also pop a bubble.
  if (isFeatureEnabled("chat-enabled")) setupChat(app, conn, tracked, zone, sub, myId, stage);

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

/**
 * Wires zone chat: every `chat_message` row feeds the side-panel history (the
 * subscription replays recent lines on join), and once live, a new row also pops
 * a bubble over the speaker's head — so bubbles fire only for present players,
 * not the backlog. Own messages emit `chat_sent` — never content (invariant 4 /
 * docs/analytics.md).
 */
function setupChat(
  app: Application,
  conn: DbConnection,
  tracked: Map<string, Tracked>,
  zone: Zone,
  sub: { live: boolean },
  myId: string | undefined,
  stage: Container,
) {
  const slug = zone.slug;
  // The `/spawn` debug command is typed in the chat box but isn't a chat line —
  // it spawns an entity at the caller's tile (server-authoritative) instead of
  // broadcasting. It has an optional flag; off → it's sent as plain chat.
  // Defaults on in local dev, off in a production build (PostHog can flip it on).
  const spawnEnabled = isFeatureEnabled("spawn-command", import.meta.env.DEV);
  // `/reset` snaps the zone's boulders (`boulder-reset`) or Hogs (`hog-reset`) back
  // to their registry layout; each target is independently gated, so bare `/reset`
  // and `/reset boulders` need boulders on, `/reset hedgehogs` needs Hogs on.
  const resetBouldersEnabled = isFeatureEnabled("boulder-reset");
  const resetHogsEnabled = isFeatureEnabled("hog-reset");
  // `/ghost` flickers the cosmetic ghost at a random tile; same flag as the launch
  // haunt (fallback on, so anyone can summon it), kept client-only.
  const ghostEnabled = isFeatureEnabled("ghost-trogg");
  const chat = mountChat(app, (text) => {
    if (spawnEnabled && handleSpawnCommand(conn, chat, text)) return;
    if (handleResetCommand(conn, chat, slug, text, resetBouldersEnabled, resetHogsEnabled)) return;
    if (ghostEnabled && handleGhostCommand(text, stage, zone)) return;
    audio.playChatSend();
    conn.reducers.chat({ text });
  });

  const senderColor = (sender: Player["identity"]) =>
    troggColorFor(conn.db.player.identity.find(sender)?.color ?? COLOR_UNSET, sender.toHexString());

  conn.db.chatMessage.onInsert((_ctx, message) => {
    const senderId = message.sender.toHexString();
    chat.addMessage(senderId, message.name, message.text, senderColor(message.sender));
    // Bubble only for fresh lines: a reconnect replays the zone's recent history,
    // and those rows can arrive after the subscription goes live — without this an
    // old message would pop a stale bubble over its sender on every refresh.
    const ageMs = Date.now() - Number(message.createdAt.microsSinceUnixEpoch / 1000n);
    if (ageMs > CHAT_BUBBLE_MS) return;
    showBubble(tracked, senderId, message.text);
    if (!sub.live) return;
    if (senderId === myId) captureEvent("chat_sent", { zone: slug });
    else audio.playChatReceive();
  });

  // A rename rewrites the denormalised name on the sender's past lines; reflect it
  // in the history panel so it doesn't show their old name until a reload.
  conn.db.chatMessage.onUpdate((_ctx, _old, message) => {
    chat.renameSender(message.sender.toHexString(), message.name);
  });

  // Colour isn't denormalised onto chat rows (it's derived from the live player
  // row), so a recolour surfaces as a player-row update — retint the sender's
  // history lines so they match the avatar without a reload.
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (_old.color !== p.color) chat.recolorSender(p.identity.toHexString(), troggColorFor(p.color, p.identity.toHexString()));
  });
}

/** The world-facing `/spawn` arguments mapped to their entity kind in the module. */
const SPAWNABLE: Record<string, "boulder" | "hog"> = { boulder: "boulder", hedgehog: "hog", hog: "hog" };

/**
 * Handle a chat line as a `/spawn <entity>` command. Returns true if it was a
 * spawn command (so the caller skips sending it as chat): a known entity fires
 * the `spawn` reducer; an unknown one or bad syntax posts a local usage hint.
 * Anything not starting with `/spawn` returns false and falls through to chat.
 */
function handleSpawnCommand(conn: DbConnection, chat: ChatUI, text: string): boolean {
  const m = /^\/spawn(?:\s+(\S+))?\s*$/i.exec(text);
  if (!m) return false;

  const hint = (msg: string) => chat.addMessage("spawn", "spawn", msg, 0x9a8c70);
  const arg = m[1]?.toLowerCase();
  if (!arg) {
    audio.playError();
    hint("usage: /spawn boulder | hedgehog");
    return true;
  }
  const kind = SPAWNABLE[arg];
  if (!kind) {
    audio.playError();
    hint(`unknown entity "${arg}" — try boulder or hedgehog`);
    return true;
  }
  audio.playCommand();
  conn.reducers.spawn({ kind });
  return true;
}

/** The `/reset` targets mapped to a stable key, so aliases resolve to one branch. */
const RESET_TARGETS: Record<string, "boulders" | "hogs"> = {
  boulder: "boulders",
  boulders: "boulders",
  hog: "hogs",
  hogs: "hogs",
  hedgehog: "hogs",
  hedgehogs: "hogs",
};

/**
 * Handle a chat line as the `/reset [boulders|hedgehogs]` command: snap the caller's
 * zone boulders or Hogs back to their registry layout (server-authoritative) instead
 * of broadcasting. Bare `/reset` resets boulders, the original behaviour. Each target
 * is independently flag-gated (`boulder-reset` / `hog-reset`); a target whose flag is
 * off, or an unknown one, posts a local usage hint. Returns true if the line was a
 * `/reset` command; anything else falls through to chat.
 */
function handleResetCommand(
  conn: DbConnection,
  chat: ChatUI,
  zone: string,
  text: string,
  bouldersEnabled: boolean,
  hogsEnabled: boolean,
): boolean {
  const m = /^\/reset(?:\s+(\S+))?\s*$/i.exec(text);
  if (!m) return false;
  // With neither target enabled, `/reset` isn't a command at all — fall through so
  // it sends as an ordinary chat line (the prior behaviour when `boulder-reset` was off).
  if (!bouldersEnabled && !hogsEnabled) return false;

  const hint = (msg: string) => chat.addMessage("reset", "reset", msg, 0x9a8c70);
  const targets = [bouldersEnabled && "boulders", hogsEnabled && "hedgehogs"].filter(Boolean).join(" | ");
  const target = m[1] ? RESET_TARGETS[m[1].toLowerCase()] : "boulders";

  if (target === "boulders" && bouldersEnabled) {
    audio.playCommand();
    conn.reducers.resetBoulders({});
    captureEvent("boulders_reset", { zone });
    return true;
  }
  if (target === "hogs" && hogsEnabled) {
    audio.playCommand();
    conn.reducers.resetHogs({});
    captureEvent("hedgehogs_reset", { zone });
    return true;
  }

  audio.playError();
  hint(`usage: /reset ${targets}`);
  return true;
}

/**
 * Handle a chat line as the `/ghost` command: flicker the cosmetic ghost trogg at a
 * random tile in the zone. Purely a client render (touches no table or reducer), so
 * only the caller sees it. Returns true if it was the command; anything else falls
 * through to chat.
 */
function handleGhostCommand(text: string, stage: Container, zone: Zone): boolean {
  if (!/^\/ghost\s*$/i.test(text)) return false;
  const x = Math.floor(Math.random() * zone.width);
  const y = Math.floor(Math.random() * zone.height);
  hauntGhost(stage, { x, y });
  return true;
}

/** Pop a speech bubble over a trogg's head, replacing any current one. */
function showBubble(tracked: Map<string, Tracked>, id: string, text: string) {
  const entry = tracked.get(id);
  if (!entry) return;

  if (entry.bubbleTimer) clearTimeout(entry.bubbleTimer);
  entry.bubble?.destroy({ children: true });

  const bubble = makeBubble(text, entry.sprite ? headTopY() : 0);
  entry.marker.addChild(bubble);
  entry.bubble = bubble;
  entry.bubbleTimer = setTimeout(() => {
    bubble.destroy({ children: true });
    if (entry.bubble === bubble) {
      entry.bubble = undefined;
      entry.bubbleTimer = undefined;
    }
  }, CHAT_BUBBLE_MS);
}

function makeBubble(text: string, topY: number): Container {
  const bubble = new Container();
  const label = new Text({
    text,
    style: { fontFamily: "monospace", fontSize: 11, fill: 0x0a0806, align: "center", wordWrap: true, wordWrapWidth: 150 },
    resolution: TEXT_RESOLUTION,
  });
  label.anchor.set(0.5, 1);
  const padX = 5;
  const padY = 3;
  const bg = new Graphics()
    .roundRect(-label.width / 2 - padX, -label.height - padY, label.width + padX * 2, label.height + padY * 2, 4)
    .fill(0xe8dcc4);
  label.position.set(0, padY);
  bubble.addChild(bg, label);
  // Float just above the head (the head top in sprite mode, the cell top for the
  // placeholder marker).
  bubble.position.set(TILE / 2, topY - 16);
  return bubble;
}

/**
 * A trogg. With the `avatar-sprites` flag on, it's the layered avatar sprite
 * (GDD "Avatars and equipment") tinted by the player's stable colour, feet at
 * the centre of the tile cell and head extending up out of it — so the
 * per-player colour, formerly the whole marker, now rides as a tint, keeping
 * "the same trogg is the same colour for everyone". With the flag off it's the
 * placeholder colour marker (a tile-filling rect). Both carry a name label.
 */
function makeMarker(name: string, color: number, self: boolean, facing: Facing, sprites: boolean) {
  const marker = new Container();
  let sprite: Sprite | undefined;
  let frameKey = "";

  if (sprites) {
    const frame = avatarFrame(false, false, 0);
    // Self gets a bright ground ring under the feet so you can pick yourself out.
    if (self) {
      const ring = new Graphics()
        .ellipse(TILE / 2, feetY(), TILE * 0.34, TILE * 0.16)
        .stroke({ width: 2, color: 0xe8dcc4 });
      marker.addChild(ring);
    }
    sprite = new Sprite(avatarTexture("trogg", facing, frame));
    // Anchor on the art's feet point (ANCHOR), not the frame's bottom edge, so the
    // feet — not the empty pixels below them — land on the tile centre.
    sprite.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
    sprite.scale.set(TILE / ART);
    sprite.position.set(TILE / 2, feetY());
    sprite.tint = color;
    marker.addChild(sprite);
    frameKey = `${facing}_${frame}`;
  } else {
    const body = new Graphics().rect(2, 2, TILE - 4, TILE - 4).fill(color);
    // Your own trogg keeps its colour but gets an outline so you can pick it out.
    if (self) body.rect(2, 2, TILE - 4, TILE - 4).stroke({ width: 2, color: 0xe8dcc4 });
    marker.addChild(body);
  }

  const label = new Text({
    text: name,
    style: { fontFamily: "monospace", fontSize: 11, fill: 0xe8dcc4 },
    resolution: TEXT_RESOLUTION,
  });
  label.anchor.set(0.5, 1);
  label.position.set(TILE / 2, sprites ? headTopY() - 2 : -2);
  marker.addChild(label);

  return { marker, sprite, frameKey };
}

/** Drive a trogg's facing and walk cycle from its synced motion intent. No-op
 *  for the placeholder marker (no sprite to swap). */
function animate(entry: Tracked, now: number, motion: ProjectedMotion) {
  if (!entry.sprite) return;
  driveSprite(entry.sprite, "trogg", motion.dirX, motion.dirY, entry.player.running, entry, now);
}

/**
 * Point a sprite's facing and stride frame at its motion intent, mutating the
 * caller's `facing`/`frameKey` so the next frame compares against it. Shared by
 * troggs and Hogs (one rig); `running` picks the faster hunched run cycle (troggs
 * only — Hogs always walk). Only touches the GPU when the frame actually changes.
 */
function driveSprite(
  sprite: Sprite,
  kind: Kind,
  dirX: number,
  dirY: number,
  running: boolean,
  state: { facing: Facing; frameKey: string },
  now: number,
) {
  const moving = dirX !== 0 || dirY !== 0;
  state.facing = facingFromDir(dirX, dirY, state.facing);
  const frame = avatarFrame(moving, running, now);
  const key = `${state.facing}_${frame}`;
  if (key === state.frameKey) return;
  sprite.texture = avatarTexture(kind, state.facing, frame);
  state.frameKey = key;
}

/** A pushable boulder: a rounded stone filling its tile, with a lit top-left face. */
function makeBoulder() {
  const sprite = new Container();
  const inset = Math.max(2, Math.round(TILE * 0.1));
  const size = TILE - inset * 2;
  const radius = Math.max(3, Math.round(TILE * 0.28));
  const px = Math.max(1, Math.round(TILE / ART));
  const body = new Graphics()
    .roundRect(inset, inset, size, size, radius)
    .fill(0x6b5640)
    .stroke({ width: px, color: 0x2a2118, alignment: 0 });
  // A small highlight reads as a lit facet under the cave's torchlight.
  body.roundRect(inset + px, inset + px, size * 0.4, size * 0.4, radius * 0.6).fill(0x8a7257);
  sprite.addChild(body);
  return sprite;
}

/**
 * The overlay for what a trogg carries (GDD "Interacting"): the held object drawn
 * small, on the trogg's person above its head — a boulder, a hog, and (later) any
 * tile-sized thing all read the same held way. `topY` is the head top in sprite
 * mode, the cell top for the placeholder marker. Unknown kind → no overlay.
 */
function makeCarried(kind: string, topY: number): Container | undefined {
  const wrap = new Container();
  if (kind === "boulder") {
    const b = makeBoulder();
    b.pivot.set(TILE / 2, TILE / 2);
    b.scale.set(CARRY_SCALE);
    wrap.addChild(b);
  } else if (kind === "hog") {
    const sprite = new Sprite(avatarTexture("hog", "down", "idle"));
    sprite.anchor.set(0.5, 0.85);
    sprite.scale.set((TILE / ART) * CARRY_SCALE);
    wrap.addChild(sprite);
  } else {
    return undefined;
  }
  wrap.position.set(TILE / 2, topY - 2);
  return wrap;
}

/** Sync a trogg's carried overlay to its `carrying` kind, rebuilding only on change. */
function applyCarry(entry: Tracked): void {
  const kind = entry.player.carrying;
  if (kind === entry.carriedKind) return;
  entry.carried?.destroy({ children: true });
  entry.carried = undefined;
  entry.carriedKind = "";
  const overlay = makeCarried(kind, entry.sprite ? headTopY() : 0);
  if (overlay) {
    entry.marker.addChild(overlay);
    entry.carried = overlay;
    entry.carriedKind = kind;
  }
}

/** A roaming Hog: the shared avatar sprite in its hedgehog skin, feet centred on the
 *  tile (like a trogg). No name label, tint, or ground ring — Hogs are ambient
 *  scenery, not players. */
function makeHog(facing: Facing): { marker: Container; sprite: Sprite; frameKey: string } {
  const marker = new Container();
  const frame = avatarFrame(false, false, 0);
  const sprite = new Sprite(avatarTexture("hog", facing, frame));
  sprite.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
  sprite.scale.set(TILE / ART);
  sprite.position.set(TILE / 2, feetY());
  marker.addChild(sprite);
  return { marker, sprite, frameKey: `${facing}_${frame}` };
}

/** Odds a given launch is haunted by the ghost trogg. */
const GHOST_CHANCE = 1 / 20;
/** How long the apparition holds before it fades. */
const GHOST_FLICKER_MS = 500;

/**
 * Cosmetic easter egg (behind `ghost-trogg`): a pale trogg materialises on the
 * given tile for a heartbeat, then fades — on launch by chance at the origin, or on
 * demand at a random tile via the `/ghost` command. Purely a client render: it
 * touches no table and no reducer (invariant 3), so it's never seen by anyone but
 * the player who summoned it.
 */
function hauntGhost(stage: Container, tile: { x: number; y: number }) {
  audio.playGhost();
  const ghost = new Container();
  const sprite = new Sprite(ghostTexture("down", "idle"));
  sprite.anchor.set(ANCHOR.x / FRAME_W, ANCHOR.y / FRAME_H);
  sprite.scale.set(TILE / ART);
  sprite.position.set(TILE / 2, feetY());
  sprite.alpha = 0.5;
  ghost.addChild(sprite);
  place(ghost, tile.x, tile.y);
  stage.addChild(ghost);

  setTimeout(() => ghost.destroy({ children: true }), GHOST_FLICKER_MS);
}

function place(marker: Container, x: number, y: number) {
  marker.position.set(x * TILE, y * TILE);
}

function centre(app: Application, stage: Container, width: number, height: number) {
  stage.position.set(
    (app.renderer.width - width * TILE) / 2,
    (app.renderer.height - height * TILE) / 2,
  );
}
