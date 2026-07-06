import { AFK_CHARGE_ACCRUAL_RATE, AFK_CHARGE_DECAY_RATE, AFK_CHARGE_MAX } from "./constants";
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

/** A trogg's presence state (GDD "The fire and the dark" → Presence) —
 *  derived, never stored. AFK is one state however much charge remains;
 *  charge only changes the gather rate, server-side. */
export function presenceOf(online: boolean): Presence {
  return online ? "active" : "afk";
}
