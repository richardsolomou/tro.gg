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
 * Associate the session with a stable account id (the OIDC subject) on the
 * guest → account upgrade, merging the guest's prior history (docs/analytics.md).
 * No-op without a PostHog key (local dev).
 */
export function identifyUser(distinctId: string) {
  if (!POSTHOG_KEY) return;
  posthog.identify(distinctId);
}

/**
 * Read a feature flag. Without PostHog, or before flags have loaded, the
 * fallback applies, so a kill-switch takes effect on the next load rather than
 * mid-session. Register code-read flags in docs/analytics.md.
 */
export function isFeatureEnabled(flag: string, fallback = true): boolean {
  if (!POSTHOG_KEY) return fallback;
  return posthog.isFeatureEnabled(flag) ?? fallback;
}

export { posthog };
