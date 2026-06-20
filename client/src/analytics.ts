import posthog from "posthog-js";
import { POSTHOG_HOST, POSTHOG_KEY } from "./env.js";

/**
 * Autocapture + session replay are first-class from day one (docs/analytics.md).
 * Custom gameplay events land with their mechanics. No-op without a key.
 */
export function initAnalytics() {
  if (!POSTHOG_KEY) return;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    person_profiles: "always",
  });
}

/** Capture a custom event. No-op without a PostHog key (local dev). */
export function captureEvent(event: string, properties?: Record<string, unknown>) {
  if (!POSTHOG_KEY) return;
  posthog.capture(event, properties);
}

/**
 * Read a feature flag (invariant 5 — every mechanic ships behind one). Without
 * PostHog, or before flags have loaded, the fallback applies, so a kill-switch
 * takes effect on the next load rather than mid-session.
 */
export function isFeatureEnabled(flag: string, fallback = true): boolean {
  if (!POSTHOG_KEY) return fallback;
  return posthog.isFeatureEnabled(flag) ?? fallback;
}

export { posthog };
