import posthog from "posthog-js";
import type { LogAttributes, LogSeverityLevel, Properties } from "posthog-js";
import { POSTHOG_HOST, POSTHOG_KEY } from "./env.js";

const serviceContext = {
  serviceName: "trogg-web",
  serviceVersion: __BUILD_ID__,
  environment: import.meta.env.MODE,
};

/**
 * Autocapture, session replay, error tracking, and logs are first-class from day
 * one (docs/analytics.md). Custom gameplay events land with their mechanics.
 * No-op without a key.
 */
export function initAnalytics() {
  if (!POSTHOG_KEY) return;
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    defaults: "2026-05-30",
    person_profiles: "always",
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    logs: {
      ...serviceContext,
      // Manual structured logs only; browser/third-party console output can include
      // incidental values we do not want to ingest blindly.
      captureConsoleLogs: false,
    },
  });
}

/** Capture a custom event. No-op without a PostHog key (local dev). */
export function captureEvent(event: string, properties?: Record<string, unknown>) {
  if (!POSTHOG_KEY) return;
  posthog.capture(event, properties);
}

/** Capture a handled exception with context. No-op without a PostHog key. */
export function captureException(error: unknown, properties?: Properties) {
  if (!POSTHOG_KEY) return;
  posthog.captureException(error, properties);
}

/** Send a structured application log. No-op without a PostHog key. */
export function captureLog(level: LogSeverityLevel, body: string, attributes?: LogAttributes) {
  if (!POSTHOG_KEY) return;
  posthog.captureLog({ level, body, attributes });
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
