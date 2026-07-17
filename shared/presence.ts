import { AFK_CHARGE_ACCRUAL_RATE, AFK_CHARGE_DECAY_RATE, AFK_CHARGE_MAX, AFK_EFFICIENCY_FRACTION, AFK_HIDE_AFTER_MS, AFK_TRICKLE_EFFICIENCY_FRACTION } from "./constants";
import { elapsedMs, type Stamp } from "./time";

export type Presence = "active" | "afk";

/**
 * A trogg's current AFK charge, derived from its stored anchor value
 * (GDD "The fire and the dark" → Presence): while online it accrues from
 * active play, while offline it decays toward zero. Never advanced on a
 * timer (invariant 1) — read fresh wherever it's needed, on client and server
 * alike, so the two never disagree. The player row's `kindlingCharge` /
 * `kindlingChargeAt` columns keep their shipped names (prod schema changes
 * only additively); this is the same value under its current name.
 */
export function deriveAfkCharge(charge: number, at: Stamp, online: boolean, now: Stamp): number {
  const ms = elapsedMs(at, now);
  if (online) return Math.min(AFK_CHARGE_MAX, charge + (ms / 60_000) * AFK_CHARGE_ACCRUAL_RATE);
  return Math.max(0, charge - (ms / 3_600_000) * AFK_CHARGE_DECAY_RATE);
}

/** An AFK trogg's instinct gather roll (GDD "Presence"): the full fraction
 *  while charge lasts; once spent, a trickle that winds down linearly to
 *  zero across the week of absence that ends with the trogg hidden. */
export function afkGatherFraction(charge: number, offlineMs: number): number {
  if (charge > 0) return AFK_EFFICIENCY_FRACTION;
  return AFK_TRICKLE_EFFICIENCY_FRACTION * Math.max(0, 1 - offlineMs / AFK_HIDE_AFTER_MS);
}

/** A trogg's presence state (GDD "The fire and the dark" → Presence) —
 *  derived, never stored. AFK is one state however much charge remains;
 *  charge only changes the gather rate, server-side. */
export function presenceOf(online: boolean): Presence {
  return online ? "active" : "afk";
}
