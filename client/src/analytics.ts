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

export { posthog };
