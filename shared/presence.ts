import { CHARGE_ACCRUAL_RATE, CHARGE_DECAY_RATE, CHARGE_MAX } from "./constants";
import { elapsedMs, type Stamp } from "./time";

export type Presence = "bright" | "ember" | "dormant";

/**
 * A trogg's current kindling charge, derived from its stored anchor value
 * (GDD "The fire and the dark" → Presence): while online it accrues from
 * bright play, while offline it decays toward zero. Never advanced on a
 * timer (invariant 1) — read fresh wherever it's needed, on client and server
 * alike, so the two never disagree.
 */
export function deriveKindlingCharge(charge: number, at: Stamp, online: boolean, now: Stamp): number {
  const ms = elapsedMs(at, now);
  if (online) return Math.min(CHARGE_MAX, charge + (ms / 60_000) * CHARGE_ACCRUAL_RATE);
  return Math.max(0, charge - (ms / 3_600_000) * CHARGE_DECAY_RATE);
}

/** A trogg's presence state (GDD "The fire and the dark" → Presence: bright,
 *  ember, dormant) — derived, never stored. */
export function presenceOf(online: boolean, derivedCharge: number): Presence {
  if (online) return "bright";
  return derivedCharge > 0 ? "ember" : "dormant";
}
