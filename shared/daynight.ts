/**
 * The shared day–night cycle (GDD "Zones"; "The fire and the dark" → Night):
 * wall-clock phased, so every client — and the server — derives the same time
 * of day from the same clock, with no sync. Phase 0 is dawn; the sun's
 * elevation is sin(phase·2π), so the back half of the cycle is night — when
 * the dark seeps back into claimed ground and only sanctuary rings hold.
 */

export const DAY_CYCLE_MS = 12 * 60 * 1000; // one full day, dawn to dawn (initial)

/** Dusk: the sun's elevation crosses zero going down. */
export const NIGHT_START_PHASE = 0.5;

export function dayPhaseAt(unixMs: number): number {
  return (((unixMs % DAY_CYCLE_MS) + DAY_CYCLE_MS) % DAY_CYCLE_MS) / DAY_CYCLE_MS;
}

export function isNightPhase(phase: number): boolean {
  return phase >= NIGHT_START_PHASE;
}

/** Night incursions (GDD "Night"): each lit region's dusk cohort is this
 *  share of its resident creature seeds — the Hearth's gentle handful scales
 *  up with depth exactly as the residents do. (initial) */
export const NIGHT_COHORT_FRACTION = 0.5;

/** The no-ambush clamp (GDD "Night"): a night creature is never placed
 *  within this many tiles of an active trogg — comfortably past aggro
 *  range, so the tide is watched coming, never materialising on top of a
 *  gatherer. (initial) */
export const NIGHT_SPAWN_MIN_PLAYER_DIST = 24;
