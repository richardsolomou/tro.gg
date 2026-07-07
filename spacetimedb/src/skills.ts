import { levelForXp, type SkillId } from "../../shared/index";
import type { Ctx } from "./schema";

/**
 * Grant active-play XP (GDD "Skills and XP"). Callers are always
 * player-initiated reducers — the AFK instinct sweep deposits into the
 * stockpile but never routes through here, which is design pillar 7 in code.
 * Returns the skill's new level and whether this grant crossed a level
 * boundary, so the caller can emit the `level_up` event (analytics.md).
 */
export function grantXp(ctx: Ctx, playerId: Ctx["sender"], skill: SkillId, xp: number): { total: number; level: number; leveledUp: boolean } {
  const gained = Math.max(0, Math.round(xp));
  let row;
  for (const r of ctx.db.skills.playerId.filter(playerId)) {
    if (r.skill === skill) {
      row = r;
      break;
    }
  }
  const before = row?.xp ?? 0;
  const total = before + gained;
  if (row) ctx.db.skills.id.update({ ...row, xp: total });
  else ctx.db.skills.insert({ id: 0n, playerId, skill, xp: total });
  const level = levelForXp(total);
  return { total, level, leveledUp: level > levelForXp(before) };
}

/** A trogg's total XP across every skill — what its overall level, and the
 *  AFK eligibility gate (GDD "Presence"), are derived from. */
export function totalXp(ctx: Ctx, playerId: Ctx["sender"]): number {
  let sum = 0;
  for (const r of ctx.db.skills.playerId.filter(playerId)) sum += r.xp;
  return sum;
}
