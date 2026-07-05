import { CHARGE_ACCRUAL_RATE, CHARGE_DECAY_RATE, CHARGE_MAX_MS } from "./constants";
import { elapsedMs, type Stamp } from "./time";

/** The player-row fields presence is derived from. */
export interface KindlingRow {
  online: boolean;
  kindlingCharge: number;
  kindlingChargeAt: Stamp;
}

/**
 * Derive a trogg's current kindling charge — ms of ember-time remaining — from
 * its banked value and how long it's been accruing (bright) or spending
 * (ember) since the anchor. Stored the same way motion is (GDD "The fire and
 * the dark" → Presence): a value plus the anchor it was true at, never
 * advanced on a timer (invariant 1).
 */
export function kindlingChargeNow(p: KindlingRow, now: Stamp): number {
  const elapsed = elapsedMs(p.kindlingChargeAt, now);
  if (p.online) return Math.min(CHARGE_MAX_MS, p.kindlingCharge + elapsed * CHARGE_ACCRUAL_RATE);
  return Math.max(0, p.kindlingCharge - elapsed * CHARGE_DECAY_RATE);
}

/** The value half of banking charge with a fresh anchor at `now` — call at
 *  every bright/ember regime transition (connect, disconnect), pairing this
 *  with `kindlingChargeAt: now` so the next derivation starts from the right
 *  value under the new regime. (A plain number, not a `{ ..., kindlingChargeAt }`
 *  pair, so callers write `now` as their own concrete timestamp type — the
 *  `settle()` convention every other derived-and-restamped field follows.) */
export function bankedKindlingCharge(p: KindlingRow, now: Stamp): number {
  return kindlingChargeNow(p, now);
}

export type Presence = "bright" | "ember" | "dormant";

/** A trogg's presence (GDD "The fire and the dark" → Presence): bright while
 *  its player is connected, ember while disconnected with charge left,
 *  dormant once that charge runs dry. */
export function presenceOf(p: KindlingRow, now: Stamp): Presence {
  if (p.online) return "bright";
  return kindlingChargeNow(p, now) > 0 ? "ember" : "dormant";
}
