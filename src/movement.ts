import {
  candidateTargets,
  facingTile,
  parsePath,
  projectMotion,
  snapToTile,
  tileKey,
  type Coord,
  type Facing,
  type ProjectedMotion,
  type Stamp,
  type ZoneBounds,
} from "@trogg/shared";
import type { DbConnection } from "./module_bindings";
import type { Player } from "./module_bindings/types";
import type { MoveIntent } from "./input.js";
import type { Tracked } from "./entities.js";

/** How long a new direction must be held before the trogg walks rather than just
 *  turning in place — the tap-vs-hold window (GDD "Movement"). Tune for feel. */
const TURN_TAP_MS = 130;

/** Min gap between click-to-move route (re)issues while a path is blocked or no route
 *  exists yet, so re-routing around a Hog — or waiting for one to clear the only way —
 *  retries steadily without firing the reducer every frame. */
const MOVETO_RETRY_MS = 250;

/** Min gap between push retries while held flush against a boulder, so a shove the server
 *  rejected (a Hog stood beyond the boulder) keeps retrying until the way clears, without
 *  firing every frame. */
const PUSH_RETRY_MS = 250;

const motionTol = 1e-6;

const sameIntent = (a: MoveIntent, b: MoveIntent) => a.dirX === b.dirX && a.dirY === b.dirY;
const sameMoveIntent = (a: MoveIntent, b: MoveIntent) => sameIntent(a, b) && a.running === b.running;
const isIdle = (i: MoveIntent) => i.dirX === 0 && i.dirY === 0;

/** A self-prediction snapshot: an origin tile plus the intent that left it. */
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

/** The audio cues movement triggers. Injected so the controller carries no browser deps. */
export interface MovementAudio {
  playFootstep(running: boolean): void;
  playBoulderPush(): void;
}

export interface SelfControllerDeps {
  conn: DbConnection;
  /** Trogg collision bounds (walls + boulders + Hogs), for re-deriving position on focus-loss. */
  bounds: ZoneBounds;
  /** Tiles Hogs occupy this frame — read live (the world rebuilds it each tick). */
  hogTiles: Set<string>;
  /** Tiles boulders occupy — read live. */
  boulderTiles: Set<string>;
  /** Whether the `boulder-pushing` flag is on. */
  pushEnabled: boolean;
  /** The local player's tracked entry, or undefined before it's been inserted. */
  getSelf: () => Tracked | undefined;
  /** Show (or clear, with undefined) the click-to-move destination marker. */
  showDestination: (tile: Coord | undefined) => void;
  /** Map a server `movedAt` onto the local monotonic clock (shared with the world). */
  toBaseMs: (movedAt: Stamp) => number;
  /** Resolve the next facing from a direction and the last facing (pure; injected to
   *  keep this module free of the avatar/pixi layer). */
  facingFromDir: (dirX: number, dirY: number, last: Facing) => Facing;
  audio: MovementAudio;
}

export type SelfController = ReturnType<typeof createSelfController>;

/**
 * The local player's movement prediction and input (GDD "Movement"). Owns the
 * grid-locked WASD/click state machine: it applies accepted input optimistically to
 * display state and treats the matching server row as an ack (`reconcile`), so motion
 * is smooth without per-frame sync (invariant 2) while authority still wins on a
 * mismatch. All prediction state lives here; the world owns rendering and feeds this
 * the per-frame projected motion via `update`.
 */
export function createSelfController(deps: SelfControllerDeps) {
  const { conn, bounds, hogTiles, boulderTiles, pushEnabled, getSelf, showDestination, toBaseMs, facingFromDir, audio } = deps;

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
  // Whether we were flush against a pushable boulder last frame, so the push sound and the
  // first shove fire once per tile (on the rising edge), not every frame.
  let pushBlocked = false;
  // When we last fired `push`, so a shove blocked by a transient obstacle (a Hog beyond the
  // boulder) retries on a throttle instead of every frame.
  let lastPushAt = 0;
  // When we last (re)issued a click-to-move route, so re-routing a blocked path — or
  // retrying when no route exists yet — is throttled (`MOVETO_RETRY_MS`).
  let lastMoveToAt = 0;
  let lastFootstepTile = "";
  // The tile our motion origin currently sits on. A straight run re-bases the origin to
  // each tile centre it crosses, so position is only ever derived over the last tile — a
  // Hog wandering onto a tile we've already passed is behind the origin and can't rewind
  // us (the WASD analogue of forward-only path projection). Dedupes the per-tile re-base
  // so it fires once per crossing, not every frame.
  let lastRebaseTile = "";
  // A click-to-move target waiting for the trogg to reach a tile centre before it
  // re-paths. Click-to-move is grid-locked like WASD (GDD "Movement"): re-basing the
  // path mid-step would let the server snap the fractional position forward to the
  // nearest tile for free, so double-clicking would bank sub-tile distance and visibly
  // speed the trogg up for everyone. Holding the click until the next centre keeps every
  // re-path on a whole tile; repeated clicks just overwrite this target.
  let pendingMoveTo: Coord | null = null;
  // The clicked destination we're routing toward (the re-route aims here, not the
  // route's truncated end), and the last path we adopted the marker from.
  let destinationTile: Coord | undefined;
  let destinationPath = "";
  // Optimistically-applied self moves awaiting their server ack, oldest first.
  const pendingSelfMoves: MotionSnapshot[] = [];

  const setDestination = (tile: Coord | undefined) => {
    destinationTile = tile;
    showDestination(tile);
  };

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
  // shoves it. The rising edge slides the boulder one tile per tile as the trogg
  // catches up (cadence falls out of walk speed) and plays the shove sound. While the
  // trogg stays flush we also retry on a throttle (`PUSH_RETRY_MS`, silent): a shove the
  // server rejected because a Hog stood beyond the boulder then resumes the instant the
  // Hog ambles off, rather than latching the trogg in place until it lets go. The server
  // re-validates and re-bases motion (invariant 3).
  const pushStep = (x: number, y: number, now: number) => {
    const into = pushEnabled && !isIdle(sent) && sameIntent(desired, sent);
    const ahead = into ? facingTile(x, y, sent.dirX, sent.dirY) : null;
    const intoBoulder = ahead != null && boulderTiles.has(tileKey(ahead.x, ahead.y));
    if (intoBoulder && (!pushBlocked || now - lastPushAt >= PUSH_RETRY_MS)) {
      if (!pushBlocked) audio.playBoulderPush();
      conn.reducers.push({});
      lastPushAt = now;
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

  /** Per-frame update for the local trogg, given its freshly projected motion. */
  const update = (entry: Tracked, motion: ProjectedMotion, now: number) => {
    const { x, y } = motion;
    playFootstepAtCentre(x, y, { dirX: motion.dirX, dirY: motion.dirY, running: entry.player.running });
    // A click-to-move route stalls when a Hog (or a shoved boulder) lands on a tile
    // ahead of it: `projectPathMotion` stops with no heading and `arrived` false.
    const stalled = entry.player.path !== "" && !motion.arrived && motion.dirX === 0 && motion.dirY === 0;
    if (!pendingMoveTo && motion.arrived && entry.player.path !== "") setDestination(undefined);
    if (pendingMoveTo) {
      flushPendingMoveTo(entry, motion, x, y, now);
    } else if (destinationTile && isIdle(desired) && (stalled || entry.player.path === "")) {
      // Heading for the clicked tile but not making progress. If we're already on a tile the
      // route could ever end on (the target itself, or a neighbour when it's blocked) we're as
      // close as we'll get — clicking our own tile, or a wall we're beside — so clear the marker
      // and stop. Otherwise the route stalled on a Hog ahead or none exists right now (a Hog
      // sealed the only way): re-issue toward the clicked tile, bending around or waiting for it
      // to clear, throttled (`MOVETO_RETRY_MS`) rather than every frame.
      const here = snapToTile({ x, y });
      if (candidateTargets(bounds, destinationTile).some((c) => c.x === here.x && c.y === here.y)) {
        setDestination(undefined);
      } else if (now - lastMoveToAt >= MOVETO_RETRY_MS) {
        lastMoveToAt = now;
        conn.reducers.moveTo({ x: destinationTile.x, y: destinationTile.y, running: false });
      }
    } else {
      driveSelf(entry, x, y, now);
    }
    pushStep(x, y, now);
    prevX = x;
    prevY = y;
  };

  /** Apply a server row for the local trogg: consume the matching optimistic move, or
   *  snap to authority on a mismatch (invariant 3). Mutates `entry` in place. */
  const reconcile = (entry: Tracked, p: Player) => {
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
      entry.baseMs = toBaseMs(p.movedAt);
      sent = playerIntent(p);
      prevX = Number.NaN;
      prevY = Number.NaN;
      pushBlocked = false;
    }
    syncDestinationFromPath(p.path);
  };

  /** Handle a keyboard intent (a direction or idle). `immediate` (focus loss) stops the
   *  trogg now rather than at the next centre, since a backgrounded tab can't animate it. */
  const onIntent = (intent: MoveIntent, immediate = false) => {
    desired = intent;
    destinationPath = "";
    // A keypress takes over from click-to-move: drop any click waiting for a centre.
    pendingMoveTo = null;
    setDestination(undefined);
    if (!immediate) return;
    const now = performance.now();
    const self = getSelf();
    walkAfter = Number.POSITIVE_INFINITY;
    if (self) {
      const { x, y } = projectMotion(self.player, now - self.baseMs, bounds);
      sendMove(self, intent, x, y, now);
    } else {
      sent = intent;
      conn.reducers.move(intent);
    }
  };

  /** Handle a click on a tile: queue a click-to-move once the trogg reaches a centre. */
  const onClick = (tile: Coord) => {
    desired = { dirX: 0, dirY: 0, running: false };
    lastDesired = desired;
    walkAfter = Number.POSITIVE_INFINITY;
    pushBlocked = false;
    destinationPath = "";
    // Show the target now, but hold the actual re-path until the trogg reaches a
    // tile centre (`flushPendingMoveTo`) — a flurry of clicks just overwrites the
    // target, so the trogg can never bank sub-tile distance between centres.
    pendingMoveTo = tile;
    setDestination(tile);
  };

  return {
    update,
    reconcile,
    onIntent,
    onClick,
    /** The trogg's current heading (sprite-only standing facing), for the interact key. */
    get facing(): MoveIntent {
      return facing;
    },
  };
}
