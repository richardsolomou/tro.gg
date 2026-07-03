import {
  candidateTargets,
  facingTile,
  parsePath,
  projectMotion,
  projectMotionState,
  snapToTile,
  tileKey,
  type Coord,
  type Facing,
  type ProjectedMotion,
  type Stamp,
  type ZoneBounds,
} from "@trogg/shared";
import type { DbConnection } from "./net/module_bindings";
import type { Player } from "./net/module_bindings/types";
import type { MoveIntent } from "./input.js";

/**
 * The slice of a tracked player this controller drives: the synced row, the local
 * extrapolation base, and the display facing. Renderer-agnostic — any world layer's
 * tracked entry (2D or 3D) satisfies it structurally.
 */
export interface MotionEntry {
  player: Player;
  baseMs: number;
  facing: Facing;
}

/** Min gap between click-to-move route (re)issues while a path is blocked or no route
 *  exists yet, so re-routing around a Hog — or waiting for one to clear the only way —
 *  retries steadily without firing the reducer every frame. */
const MOVETO_RETRY_MS = 250;

/** Min gap between push retries while held flush against a boulder, so a shove the server
 *  rejected (a Hog stood beyond the boulder) keeps retrying until the way clears, without
 *  firing every frame. */
const PUSH_RETRY_MS = 250;

/** How far ahead the "can I move at all?" probe looks. Long enough that a blocked
 *  probe means genuinely flush against something, short enough to stay cheap. */
const PROBE_MS = 60;

const motionTol = 1e-6;

const sameIntent = (a: MoveIntent, b: MoveIntent) => a.dirX === b.dirX && a.dirY === b.dirY;
const sameMoveIntent = (a: MoveIntent, b: MoveIntent) => sameIntent(a, b) && a.running === b.running;
const isIdle = (i: MoveIntent) => i.dirX === 0 && i.dirY === 0;

/** The cardinal a (possibly diagonal) intent reads as, for facing and tile targeting. */
const dominantCardinal = (i: MoveIntent): MoveIntent =>
  Math.abs(i.dirX) >= Math.abs(i.dirY) ? { dirX: Math.sign(i.dirX), dirY: 0, running: false } : { dirX: 0, dirY: Math.sign(i.dirY), running: false };

/** A self-prediction snapshot: an origin plus the intent that left it. */
interface MotionSnapshot extends MoveIntent {
  x: number;
  y: number;
  path: string;
}

function playerIntent(p: Pick<Player, "dirX" | "dirY" | "running">): MoveIntent {
  return { dirX: p.dirX, dirY: p.dirY, running: p.running };
}

function playerMotion(p: Pick<Player, "x" | "y" | "dirX" | "dirY" | "running" | "path">): MotionSnapshot {
  return { x: p.x, y: p.y, dirX: p.dirX, dirY: p.dirY, running: p.running, path: p.path };
}

function sameMotion(a: MotionSnapshot, b: MotionSnapshot): boolean {
  return Math.abs(a.x - b.x) < motionTol && Math.abs(a.y - b.y) < motionTol && sameMoveIntent(a, b) && a.path === b.path;
}

function withMotion(p: Player, motion: MotionSnapshot): Player {
  return { ...p, x: motion.x, y: motion.y, dirX: motion.dirX, dirY: motion.dirY, running: motion.running, path: motion.path };
}

function withFacing(p: Player, intent: MoveIntent): Player {
  if (isIdle(intent)) return p;
  const f = dominantCardinal(intent);
  return { ...p, faceX: f.dirX, faceY: f.dirY };
}

function playerFacing(p: Pick<Player, "faceX" | "faceY">): MoveIntent {
  return { dirX: p.faceX, dirY: p.faceY, running: false };
}

/** The audio cues movement triggers. Injected so the controller carries no browser deps. */
export interface MovementAudio {
  playFootstep(running: boolean): void;
  playBoulderPush(): void;
}

export interface SelfControllerDeps {
  conn: DbConnection;
  /** Trogg collision bounds (walls + boulders + Hogs), for prediction and probes. */
  bounds: ZoneBounds;
  /** Tiles Hogs occupy this frame — read live (the world rebuilds it each tick). */
  hogTiles: Set<string>;
  /** Tiles boulders occupy — read live. */
  boulderTiles: Set<string>;
  /** Whether the `boulder-pushing` flag is on. */
  pushEnabled: boolean;
  /** The local player's tracked entry, or undefined before it's been inserted. */
  getSelf: () => MotionEntry | undefined;
  /** Show (or clear, with undefined) the click-to-move destination marker. */
  showDestination: (tile: Coord | undefined) => void;
  /** Map a server `movedAt` onto the local monotonic clock (shared with the world). */
  toBaseMs: (movedAt: Stamp) => number;
  /** Resolve the next facing from a direction and the last facing (pure; injected to
   *  keep this module free of the avatar/render layer). */
  facingFromDir: (dirX: number, dirY: number, last: Facing) => Facing;
  audio: MovementAudio;
}

export type SelfController = ReturnType<typeof createSelfController>;

/**
 * The local player's movement prediction and input (GDD "Movement"). Owns the
 * free-movement WASD/click state machine: it applies accepted input optimistically to
 * display state and treats the matching server row as an ack (`reconcile`), so motion
 * is smooth without per-frame sync (invariant 2) while authority still wins on a
 * mismatch. Movement is free 8-directional: intents send on input transitions from
 * wherever the trogg stands (origins are fractional — the server settles at the same
 * derived spot, so nothing is banked or snapped). All prediction state lives here;
 * the world owns rendering and feeds this the per-frame projected motion via `update`.
 */
export function createSelfController(deps: SelfControllerDeps) {
  const { conn, bounds, hogTiles, boulderTiles, pushEnabled, getSelf, showDestination, toBaseMs, facingFromDir, audio } = deps;

  // `desired` is what the keys want now; `sent` is the committed display intent
  // (idle = stopped); `facing` is the cardinal the trogg points (display + tile
  // targeting — set even while standing still).
  let desired: MoveIntent = { dirX: 0, dirY: 0, running: false };
  let sent: MoveIntent = { dirX: 0, dirY: 0, running: false };
  let facing: MoveIntent = { dirX: 0, dirY: 1, running: false };
  // Whether we were flush against a pushable boulder last frame, so the push sound and the
  // first shove fire once (on the rising edge), not every frame.
  let pushBlocked = false;
  // When we last fired `push`, so a shove blocked by a transient obstacle (a Hog beyond the
  // boulder) retries on a throttle instead of every frame.
  let lastPushAt = 0;
  // When we last (re)issued a click-to-move route (`MOVETO_RETRY_MS` throttle).
  let lastMoveToAt = 0;
  // The tile the trogg last stood on, tracked separately for the footstep cadence and
  // for the once-per-crossing origin re-base (they read the same crossings, but the
  // footstep check runs first each frame and must not consume the re-base's edge).
  let lastFootstepTile = "";
  let lastRebaseTile = "";
  // A click-to-move route has been dispatched but its row hasn't come back yet. Until
  // it does, a fresh click would re-fire `moveTo` and the second settle would bump
  // `movedAt`, rewinding the animation for everyone. Hold re-routes until the ack.
  let awaitingMoveTo = false;
  // The tile the live route was dispatched to: a repeat click on it is dropped rather
  // than re-pathed (a re-path resets movedAt and can project one frame of negative
  // elapsed, visibly snapping the trogg backward).
  let routedTarget: Coord | null = null;
  // The clicked destination we're routing toward (re-routes aim here, not the route's
  // truncated end), and the last path we adopted the marker from.
  let pendingMoveTo: Coord | null = null;
  let destinationTile: Coord | undefined;
  let destinationPath = "";
  // Optimistically-applied self moves awaiting their server ack, oldest first.
  const pendingSelfMoves: MotionSnapshot[] = [];
  // Last authoritative motion accepted from the server. Non-motion row updates can
  // arrive while a local move is still pending; if they carry this older motion,
  // merge their visual fields without snapping the optimistic prediction backward.
  let acknowledgedMotion: MotionSnapshot | null = null;
  // A duplicate signed-in tab sees the same player row as "self", but should act as
  // an observer until this tab receives local keyboard input.
  let keyboardControlling = false;

  const setDestination = (tile: Coord | undefined) => {
    destinationTile = tile;
    if (!tile) routedTarget = null;
    showDestination(tile);
  };

  const syncFacingFromSelfRow = () => {
    const self = getSelf();
    if (!self || pendingSelfMoves.length > 0) return;
    const synced = playerFacing(self.player);
    if (!isIdle(synced)) facing = synced;
  };

  const setFacing = (entry: MotionEntry, intent: MoveIntent) => {
    if (isIdle(intent)) return;
    facing = dominantCardinal(intent);
    entry.player = withFacing(entry.player, intent);
    entry.facing = facingFromDir(intent.dirX, intent.dirY, entry.facing);
  };

  /** Would this intent make any progress from (x, y) right now? False means flush
   *  against a wall, boulder, or Hog with nowhere to slide. */
  const canProgress = (x: number, y: number, intent: MoveIntent): boolean => {
    const probe = projectMotionState({ x, y, dirX: intent.dirX, dirY: intent.dirY, running: intent.running, path: "" }, PROBE_MS, bounds);
    return Math.abs(probe.x - x) + Math.abs(probe.y - y) > 1e-4;
  };

  const sendMove = (entry: MotionEntry, intent: MoveIntent, x: number, y: number, now: number) => {
    const motion: MotionSnapshot = { ...intent, x, y, path: "" };
    const wasIdle = isIdle(sent);
    sent = intent;
    acknowledgedMotion ??= playerMotion(entry.player);
    pendingSelfMoves.push(motion);
    entry.player = withMotion(entry.player, motion);
    entry.baseMs = now;
    const tile = snapToTile({ x, y });
    lastFootstepTile = tileKey(tile.x, tile.y);
    lastRebaseTile = lastFootstepTile;
    if (!isIdle(intent)) {
      setFacing(entry, intent);
      if (wasIdle) audio.playFootstep(intent.running);
    }
    conn.reducers.move(intent);
    if (isIdle(intent) && isIdle(desired)) keyboardControlling = false;
  };

  const sendFace = (entry: MotionEntry, intent: MoveIntent, x: number, y: number, now: number) => {
    const cardinal = dominantCardinal(intent);
    if (isIdle(cardinal) || sameIntent(cardinal, facing)) return;
    entry.player = withMotion(entry.player, { x, y, dirX: 0, dirY: 0, running: false, path: "" });
    entry.baseMs = now;
    sent = { dirX: 0, dirY: 0, running: false };
    setFacing(entry, intent);
    conn.reducers.face({ dirX: cardinal.dirX, dirY: cardinal.dirY });
  };

  /** Footsteps on tile crossings — free movement's stride cadence. */
  const playFootstepOnCrossing = (x: number, y: number, intent: MoveIntent) => {
    if (isIdle(intent)) return;
    const tile = snapToTile({ x, y });
    const key = tileKey(tile.x, tile.y);
    if (key === lastFootstepTile) return;
    lastFootstepTile = key;
    audio.playFootstep(intent.running);
  };

  // Push (GDD "Pushing", gated by its optional flag) fires while the trogg is
  // *actively pressing* a cardinal into a boulder it sits flush against
  // (`facingTile` — a diagonal press faces nothing, so it never shoves). The rising
  // edge slides the boulder one tile and plays the shove sound; while flush we also
  // retry on a throttle (`PUSH_RETRY_MS`, silent) so a shove the server rejected
  // (a Hog beyond the boulder) resumes the instant the way clears. The server
  // re-validates and re-bases motion (invariant 3).
  const pushStep = (x: number, y: number, now: number) => {
    const pressing = pushEnabled && !isIdle(desired);
    const ahead = pressing ? facingTile(x, y, desired.dirX, desired.dirY) : null;
    const intoBoulder = ahead != null && boulderTiles.has(tileKey(ahead.x, ahead.y));
    if (intoBoulder && (!pushBlocked || now - lastPushAt >= PUSH_RETRY_MS)) {
      if (!pushBlocked) audio.playBoulderPush();
      conn.reducers.push({});
      lastPushAt = now;
    }
    pushBlocked = intoBoulder;
  };

  const driveSelf = (entry: MotionEntry, x: number, y: number, now: number) => {
    const pathing = entry.player.path !== "";

    if (pathing) {
      // A keypress takes over from a click route immediately.
      if (!isIdle(desired)) sendMove(entry, desired, x, y, now);
      return;
    }

    if (!sameMoveIntent(desired, sent)) {
      if (isIdle(desired)) {
        sendMove(entry, desired, x, y, now);
        return;
      }
      if (!canProgress(x, y, desired)) {
        // Flush against a wall, boulder, or Hog: stand facing it rather than store a
        // moving intent that banks elapsed travel (the moment the blocker cleared, a
        // stale origin would fling the trogg to wherever the uninterrupted walk had
        // reached). This re-checks every frame, so movement resumes the instant the
        // way opens while the key is still held.
        sendFace(entry, desired, x, y, now);
        return;
      }
      sendMove(entry, desired, x, y, now);
      return;
    }

    if (!isIdle(sent)) {
      // Moving as desired. If something stepped into the way and we're pinned, stop
      // (the desired≠sent branch above then handles the wait-and-resume). Otherwise
      // re-base the origin on each tile crossing so position is only ever derived
      // over the last tile — an obstacle landing on a tile already crossed sits
      // behind the origin and can't rewind us.
      if (!canProgress(x, y, sent)) {
        sendMove(entry, { dirX: 0, dirY: 0, running: false }, x, y, now);
        return;
      }
      const tile = snapToTile({ x, y });
      const key = tileKey(tile.x, tile.y);
      if (key !== lastRebaseTile) sendMove(entry, sent, x, y, now);
    } else if (isIdle(desired)) {
      keyboardControlling = false;
    }
  };

  /** Dispatch a clicked destination: immediately unless a route is already in flight
   *  (then it re-fires on the ack). Free movement banks nothing, so there's no
   *  centre-wait — the server settles at the same derived spot we're standing on. */
  const flushPendingMoveTo = (entry: MotionEntry, motion: ProjectedMotion, now: number) => {
    if (!pendingMoveTo || awaitingMoveTo) return;
    const dir = { dirX: motion.dirX, dirY: motion.dirY, running: entry.player.running };
    // Already gliding along a live route to this exact tile? Re-clicking it changes
    // nothing, so don't re-path (which would reset movedAt and snap the trogg).
    if (routedTarget && routedTarget.x === pendingMoveTo.x && routedTarget.y === pendingMoveTo.y && entry.player.path !== "" && !isIdle(dir)) {
      pendingMoveTo = null;
      return;
    }
    const target = pendingMoveTo;
    pendingMoveTo = null;
    awaitingMoveTo = true;
    routedTarget = target;
    sent = { dirX: 0, dirY: 0, running: false };
    pendingSelfMoves.length = 0;
    lastMoveToAt = now;
    conn.reducers.moveTo({ x: target.x, y: target.y, running: false });
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
    // We only adopt the route's end when there's no marker yet (resuming after a reconnect).
    if (!destinationTile) setDestination(parsePath(path).at(-1));
  };

  /** Per-frame update for the local trogg, given its freshly projected motion. */
  const update = (entry: MotionEntry, motion: ProjectedMotion, now: number) => {
    const { x, y } = motion;
    playFootstepOnCrossing(x, y, { dirX: motion.dirX, dirY: motion.dirY, running: entry.player.running });
    // A click-to-move route stalls when a Hog (or a shoved boulder) lands on a tile
    // ahead of it: `projectPathMotion` stops with no heading and `arrived` false.
    const stalled = entry.player.path !== "" && !motion.arrived && motion.dirX === 0 && motion.dirY === 0;
    if (!pendingMoveTo && motion.arrived && entry.player.path !== "") setDestination(undefined);
    if (pendingMoveTo) {
      flushPendingMoveTo(entry, motion, now);
    } else if (destinationTile && isIdle(desired) && (stalled || entry.player.path === "")) {
      // Heading for the clicked tile but not making progress. If we're already on a tile
      // the route could ever end on we're as close as we'll get — clear the marker and
      // stop. Otherwise re-issue toward the clicked tile, throttled.
      const here = snapToTile({ x, y });
      if (candidateTargets(bounds, destinationTile).some((c) => c.x === here.x && c.y === here.y)) {
        setDestination(undefined);
      } else if (now - lastMoveToAt >= MOVETO_RETRY_MS) {
        lastMoveToAt = now;
        conn.reducers.moveTo({ x: destinationTile.x, y: destinationTile.y, running: false });
      }
    } else {
      if (keyboardControlling) driveSelf(entry, x, y, now);
    }
    if (keyboardControlling) pushStep(x, y, now);
  };

  /** Apply a server row for the local trogg: consume the matching optimistic move, or
   *  snap to authority on a mismatch (invariant 3). Mutates `entry` in place. */
  const reconcile = (entry: MotionEntry, p: Player) => {
    // Any server row for us means a dispatched route (if one was in flight) has landed —
    // re-routing is allowed again.
    awaitingMoveTo = false;
    const serverMotion = playerMotion(p);
    const pendingIndex = pendingSelfMoves.findIndex((motion) => sameMotion(motion, serverMotion));
    if (pendingIndex >= 0) {
      pendingSelfMoves.splice(0, pendingIndex + 1);
      acknowledgedMotion = serverMotion;
      entry.player = withMotion(p, playerMotion(entry.player));
    } else if (sameMotion(playerMotion(entry.player), serverMotion)) {
      acknowledgedMotion = serverMotion;
      entry.player = withMotion(p, playerMotion(entry.player));
    } else if (pendingSelfMoves.length > 0 && acknowledgedMotion && sameMotion(serverMotion, acknowledgedMotion)) {
      entry.player = withMotion(p, playerMotion(entry.player));
    } else {
      pendingSelfMoves.length = 0;
      acknowledgedMotion = serverMotion;
      entry.player = p;
      entry.baseMs = toBaseMs(p.movedAt);
      sent = keyboardControlling ? playerIntent(p) : { dirX: 0, dirY: 0, running: false };
      pushBlocked = false;
    }
    if (p.faceX !== 0 || p.faceY !== 0) facing = playerFacing(p);
    syncDestinationFromPath(p.path);
  };

  /** Handle a keyboard intent (a direction or idle). `immediate` (focus loss) sends the
   *  stop now rather than on the next frame, since a backgrounded tab stops animating. */
  const onIntent = (intent: MoveIntent, immediate = false) => {
    syncFacingFromSelfRow();
    if (!isIdle(intent)) keyboardControlling = true;
    desired = intent;
    destinationPath = "";
    // A keypress takes over from click-to-move: drop any queued click.
    pendingMoveTo = null;
    setDestination(undefined);
    if (!immediate) return;
    const now = performance.now();
    const self = getSelf();
    if (self) {
      const { x, y } = projectMotion(self.player, now - self.baseMs, bounds);
      if (keyboardControlling || !isIdle(intent)) sendMove(self, intent, x, y, now);
    } else {
      if (keyboardControlling || !isIdle(intent)) {
        sent = intent;
        conn.reducers.move(intent);
      }
    }
  };

  /** Handle a click on a tile: queue a click-to-move (dispatched this same frame
   *  unless a previous route is still unacked). */
  const onClick = (tile: Coord) => {
    desired = { dirX: 0, dirY: 0, running: false };
    pushBlocked = false;
    destinationPath = "";
    pendingMoveTo = tile;
    keyboardControlling = false;
    setDestination(tile);
  };

  return {
    update,
    reconcile,
    onIntent,
    onClick,
    /** The trogg's current heading (cardinal standing facing), for the interact key. */
    get facing(): MoveIntent {
      return facing;
    },
  };
}
