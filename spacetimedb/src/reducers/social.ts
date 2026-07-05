import spacetimedb, { type Ctx, type AnalyticsEvent } from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  CHAT_HISTORY_MAX,
  CHAT_MAX_CHARS,
  CHAT_RATE_LIMIT_MS,
  elapsedMs,
  getZone,
  isColorIndex,
  isTroggStyleIndex,
  isValidName,
  TROGG_STYLES,
} from "../../../shared/index";
import {
  captureProcedureEvents,
  sourceProp,
  distinctId,
  unit,
  randomWalkableTile,
  trimGhostHaunts,
  nameTaken,
  recordBrightActivity,
} from "../helpers";

/**
 * A zone-scoped chat line. Validate length, enforce the per-player rate limit
 * (invariant 3 — never trust the client), append the row, and trim the zone's
 * history to its cap.
 */
function runChat(ctx: Ctx, { text, source = "" }: { text: string; source?: string }): AnalyticsEvent[] {
  let p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  p = recordBrightActivity(ctx, p);

  const trimmed = text.trim().slice(0, CHAT_MAX_CHARS);
  if (!trimmed) return [];

  if (p.lastChatAt && elapsedMs(p.lastChatAt, ctx.timestamp) < CHAT_RATE_LIMIT_MS) return [];
  ctx.db.player.identity.update({ ...p, lastChatAt: ctx.timestamp });

  ctx.db.chatMessage.insert({
    id: 0n,
    zoneId: p.zoneId,
    sender: ctx.sender,
    name: p.name,
    text: trimmed,
    createdAt: ctx.timestamp,
  });

  // Cap the zone's history. We trim on every insert, so the backlog is over by at most
  // one — drop the single oldest row (lowest auto-inc id) in a single pass, rather than
  // materializing and sorting the whole zone history on each message.
  let count = 0;
  let oldest: bigint | undefined;
  for (const line of ctx.db.chatMessage.zoneId.filter(p.zoneId)) {
    count++;
    if (oldest === undefined || line.id < oldest) oldest = line.id;
  }
  if (count > CHAT_HISTORY_MAX && oldest !== undefined) ctx.db.chatMessage.id.delete(oldest);
  return [{ distinctId: distinctId(ctx), event: "chat_sent", properties: { zone: p.zoneId, ...sourceProp(source) } }];
}

export const chat = spacetimedb.reducer({ text: t.string() }, (ctx, args) => {
  runChat(ctx, args);
});

export const chatAction = spacetimedb.procedure(
  { text: t.string(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runChat(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Flicker a cosmetic ghost in the caller's zone. The server chooses a random walkable
 * tile and inserts a zone-scoped event row so every live subscriber in the map sees
 * the same haunt. It has no collision or durable gameplay effect.
 */
function runHauntGhostOnce(ctx: Ctx): string | undefined {
  let p = ctx.db.player.identity.find(ctx.sender);
  if (!p || !p.online) return undefined;
  p = recordBrightActivity(ctx, p);
  const zone = getZone(p.zoneId);
  if (!zone) return undefined;

  const tile = randomWalkableTile(ctx, zone);
  if (!tile) return undefined;

  ctx.db.ghostHaunt.insert({ id: 0n, zoneId: p.zoneId, x: tile.x, y: tile.y, createdAt: ctx.timestamp });
  trimGhostHaunts(ctx, p.zoneId);
  return p.zoneId;
}

function runHauntGhost(ctx: Ctx, { count = 1, source = "" }: { count?: number; source?: string } = {}): AnalyticsEvent[] {
  const wanted = Number.isSafeInteger(count) ? Math.max(1, Math.min(12, Math.floor(count))) : 1;
  let zone: string | undefined;
  let inserted = 0;
  for (let i = 0; i < wanted; i++) {
    const nextZone = runHauntGhostOnce(ctx);
    if (!nextZone) continue;
    zone = nextZone;
    inserted++;
  }
  if (!zone || inserted === 0) return [];
  return [{ distinctId: distinctId(ctx), event: "ghost_summoned", properties: { zone, count: inserted, ...sourceProp(source) } }];
}

export const hauntGhost = spacetimedb.reducer((ctx) => {
  runHauntGhost(ctx);
});

export const hauntGhostAction = spacetimedb.procedure(
  { count: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runHauntGhost(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Rename the caller's trogg (GDD "Identity": names are unique, 3–20 chars,
 * alphanumeric + hyphen). This is how a player swaps the generated `trogg-####`
 * for one they choose. Validation and the uniqueness scan run server-side
 * (invariant 3); an invalid or taken name is a silent no-op, like a rejected chat
 * line, and the client sees its name simply not change. The denormalised name on
 * the player's past chat lines is rewritten too, so history shows their current
 * name rather than whatever they were called when each line was sent.
 */
function runRename(ctx: Ctx, { name, source = "" }: { name: string; source?: string }): AnalyticsEvent[] {
  let p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  p = recordBrightActivity(ctx, p);

  const trimmed = name.trim();
  if (trimmed === p.name || !isValidName(trimmed) || nameTaken(ctx, trimmed, ctx.sender)) return [];

  ctx.db.player.identity.update({ ...p, name: trimmed });
  for (const line of ctx.db.chatMessage.iter()) {
    if (line.sender.isEqual(ctx.sender)) ctx.db.chatMessage.id.update({ ...line, name: trimmed });
  }
  return [{ distinctId: distinctId(ctx), event: "trogg_renamed", properties: { zone: p.zoneId, ...sourceProp(source) } }];
}

export const rename = spacetimedb.reducer({ name: t.string() }, (ctx, args) => {
  runRename(ctx, args);
});

export const renameAction = spacetimedb.procedure(
  { name: t.string(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runRename(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Recolour the caller's trogg (GDD "Avatars and equipment"): store a chosen index
 * into the shared `TROGG_COLORS` palette, replacing the id-derived default. The
 * index is validated server-side (invariant 3); an out-of-range index or one
 * already set is a silent no-op, like `rename`. The colour rides the zone player
 * sync, so the tint updates for everyone; chat name colour is derived from the
 * same row, so no denormalised copy needs rewriting.
 */
function runRecolor(ctx: Ctx, { color, source = "" }: { color: number; source?: string }): AnalyticsEvent[] {
  let p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  p = recordBrightActivity(ctx, p);
  if (color === p.color || !isColorIndex(color)) return [];
  ctx.db.player.identity.update({ ...p, color });
  return [{ distinctId: distinctId(ctx), event: "trogg_recolored", properties: { color, ...sourceProp(source) } }];
}

export const recolor = spacetimedb.reducer({ color: t.i32() }, (ctx, args) => {
  runRecolor(ctx, args);
});

export const recolorAction = spacetimedb.procedure(
  { color: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runRecolor(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);

/**
 * Restyle the caller's trogg (GDD "Avatars and equipment"): store a chosen index
 * into the shared `TROGG_STYLES` list, replacing the id-derived default. The mirror
 * of `recolor` on the other appearance axis (shape, not tint). The index is
 * validated server-side (invariant 3); an out-of-range index or one already set is
 * a silent no-op. The style rides the zone player sync, so the sprite swaps for
 * everyone.
 */
function runRestyle(ctx: Ctx, { style, source = "" }: { style: number; source?: string }): AnalyticsEvent[] {
  let p = ctx.db.player.identity.find(ctx.sender);
  if (!p) return [];
  p = recordBrightActivity(ctx, p);
  if (style === p.style || !isTroggStyleIndex(style)) return [];
  ctx.db.player.identity.update({ ...p, style });
  return [{ distinctId: distinctId(ctx), event: "trogg_restyled", properties: { style: TROGG_STYLES[style] ?? String(style), ...sourceProp(source) } }];
}

export const restyle = spacetimedb.reducer({ style: t.i32() }, (ctx, args) => {
  runRestyle(ctx, args);
});

export const restyleAction = spacetimedb.procedure(
  { style: t.i32(), posthogKey: t.string(), source: t.string() },
  t.unit(),
  (ctx, args) => {
    const events = ctx.withTx((tx) => runRestyle(tx, args));
    captureProcedureEvents(ctx, args.posthogKey, events);
    return unit();
  },
);
