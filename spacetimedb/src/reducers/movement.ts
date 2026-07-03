import spacetimedb from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  elapsedMs,
  findPath,
  getZone,
  projectMotion,
  serializePath,
  smoothPath,
  tileKey,
  zoneBounds,
} from "../../../shared/index";
import {
  settle,
  troggBlockers,
  cardinal,
  directionVector,
} from "../helpers";

/**
 * A WASD direction intent (GDD "Movement"). Movement is free-direction: the
 * heading is an integer vector on the DIR_SCALE wire format (camera-relative
 * strafing quantises to it; the shared projection normalises, so magnitude never
 * buys speed). Settle the origin to where the trogg is now (so elapsed travel
 * under the old direction — and the old speed — isn't lost or replayed), then
 * store the new heading, `running`, and timestamp; origins are fractional.
 * `running` (shift held) rides the intent so all clients derive the same faster
 * speed. Non-idle movement also updates the synced standing facing (its dominant
 * cardinal), so stopping preserves the heading other clients just saw. Position
 * is never ticked (invariant 1); axis values are clamped, never trusted
 * (invariant 3).
 */
export const move = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32(), running: t.bool() }, (ctx, { dirX, dirY, running }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const dir = directionVector(dirX, dirY);
  const idle = dir.dirX === 0 && dir.dirY === 0;
  const dominant = Math.abs(dir.dirX) >= Math.abs(dir.dirY) ? { x: Math.sign(dir.dirX), y: 0 } : { x: 0, y: Math.sign(dir.dirY) };
  const settled = settle(ctx, p, ctx.timestamp);
  ctx.db.player.identity.update({
    ...p,
    x: settled.x,
    y: settled.y,
    z: settled.z,
    dirX: dir.dirX,
    dirY: dir.dirY,
    running,
    path: "",
    faceX: idle ? p.faceX : dominant.x,
    faceY: idle ? p.faceY : dominant.y,
    movedAt: ctx.timestamp,
  });
});

/**
 * A standing turn (GDD "Movement" tap-to-turn). Facing is input-driven like movement:
 * the client sends it only on a direction transition, never per frame. The reducer
 * settles and stops current motion before storing the facing, so a forged mid-walk
 * `face` call can't make the trogg glide sideways (invariant 3).
 */
export const face = spacetimedb.reducer({ dirX: t.i32(), dirY: t.i32() }, (ctx, { dirX, dirY }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const dir = cardinal(dirX, dirY);
  if (!dir || (dir.dirX === 0 && dir.dirY === 0)) return;
  const settled = settle(ctx, p, ctx.timestamp);
  ctx.db.player.identity.update({
    ...p,
    x: settled.x,
    y: settled.y,
    z: settled.z,
    dirX: 0,
    dirY: 0,
    running: false,
    path: "",
    faceX: dir.dirX,
    faceY: dir.dirY,
    movedAt: ctx.timestamp,
  });
});

/**
 * Click-to-move (GDD "Movement"). The server computes the route over the zone's
 * walkable tiles plus current boulder occupancy, stores the path as the synced
 * motion intent, and every client derives animation from that row. If the clicked
 * tile is blocked, `findPath` routes to the nearest reachable cardinal neighbour.
 */
export const moveTo = spacetimedb.reducer({ x: t.i32(), y: t.i32(), running: t.bool() }, (ctx, target) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return;
  if (p.dead) return;
  const zone = getZone(p.zoneId);
  if (!zone) return;

  const blockers = troggBlockers(ctx, p.zoneId, ctx.timestamp);
  const bounds = zoneBounds(zone, (x, y) => blockers.has(tileKey(x, y)));
  const start = settle(ctx, p, ctx.timestamp);
  // A* finds the route; string-pulling collapses it to the fewest straight hops, so
  // open floor is one direct glide and only genuine corners keep bends (free movement).
  const path = smoothPath(bounds, start, findPath(bounds, start, { x: target.x, y: target.y }));
  const first = path[0];

  // The stored origin stays fractional; the route's first hop is the glide from it
  // onto the first waypoint (shared projection). Facing is the hop's dominant cardinal.
  const hopX = first ? first.x - start.x : 0;
  const hopY = first ? first.y - start.y : 0;
  const faceX = Math.abs(hopX) >= Math.abs(hopY) ? Math.sign(hopX) : 0;
  const faceY = Math.abs(hopX) >= Math.abs(hopY) ? 0 : Math.sign(hopY);
  ctx.db.player.identity.update({
    ...p,
    x: start.x,
    y: start.y,
    z: start.z,
    dirX: faceX,
    dirY: faceY,
    running: target.running,
    path: serializePath(path),
    faceX: first ? faceX : p.faceX,
    faceY: first ? faceY : p.faceY,
    movedAt: ctx.timestamp,
  });
});


