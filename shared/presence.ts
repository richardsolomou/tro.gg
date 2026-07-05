import {
  KINDLING_ACTIVITY_WINDOW_MS,
  KINDLING_CHARGE_ACCRUAL_RATE,
  KINDLING_CHARGE_DECAY_RATE,
  KINDLING_CHARGE_MAX_MS,
} from "./constants";
import { elapsedMs, type Stamp } from "./time";

export type PresenceState = "bright" | "ember" | "dormant";

export interface KindlingState {
  online: boolean;
  kindlingCharge?: number;
  kindlingChargeAt?: Stamp;
}

export function derivedKindlingCharge(state: KindlingState, now: Stamp): number {
  const charge = Math.max(0, state.kindlingCharge ?? 0);
  if (!state.kindlingChargeAt) return charge;
  const elapsed = Math.max(0, elapsedMs(state.kindlingChargeAt, now));
  if (state.online) {
    const earned = Math.min(elapsed, KINDLING_ACTIVITY_WINDOW_MS) * KINDLING_CHARGE_ACCRUAL_RATE;
    return Math.min(KINDLING_CHARGE_MAX_MS, charge + earned);
  }
  return Math.max(0, charge - elapsed * KINDLING_CHARGE_DECAY_RATE);
}

export function presenceState(state: KindlingState, now: Stamp): PresenceState {
  if (state.online) return "bright";
  return derivedKindlingCharge(state, now) > 0 ? "ember" : "dormant";
}

export function kindlingFraction(state: KindlingState, now: Stamp): number {
  return derivedKindlingCharge(state, now) / KINDLING_CHARGE_MAX_MS;
}
