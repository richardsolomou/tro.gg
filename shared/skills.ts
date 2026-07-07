/**
 * Skills and XP (GDD "Skills and XP"): per-player, per-skill accumulated XP.
 * Levels are derived, never stored — `levelForXp` is the one curve every
 * surface reads, and a trogg's overall level is the same curve applied to its
 * total XP across every skill (never a sum of per-skill levels).
 */

/** The shipped progression tracks. Foraging joins when glowcap nodes ship. */
export const SKILL_IDS = ["mining", "woodcutting", "combat"] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export function isSkillId(value: string): value is SkillId {
  return (SKILL_IDS as readonly string[]).includes(value);
}

export const LEVEL_CAP = 50; // (initial)

/** Total XP to reach level L: 50 × (L − 1)² (initial) — level 2 at 50, level 10 at 4,050. */
export function xpForLevel(level: number): number {
  const l = Math.max(1, Math.min(LEVEL_CAP, Math.floor(level)));
  return 50 * (l - 1) ** 2;
}

/** The level a given XP total has reached — the inverse of `xpForLevel`, capped. */
export function levelForXp(xp: number): number {
  if (!(xp > 0)) return 1;
  return Math.min(LEVEL_CAP, Math.floor(Math.sqrt(xp / 50)) + 1);
}

/** XP granted by an active trogg's breaking hit on a gather node. (initial) */
export const GATHER_XP = 10;

/** Combat XP per point of damage dealt to a dark creature, clamped to its
 *  remaining health so overkill buys nothing. Damaging a trogg grants none —
 *  no progression incentive to hit your own tribe. (initial) */
export const COMBAT_XP_PER_DAMAGE = 1;
