import posthog from "posthog-js";
import { POSTHOG_HOST, POSTHOG_KEY } from "./env.js";

const serviceContext = {
  serviceName: "trogg-web",
  serviceVersion: __BUILD_ID__,
  environment: import.meta.env.MODE,
};

type LogAttribute = string | number | boolean | null | undefined | unknown[] | Record<string, unknown>;
type LogAttributes = Record<string, LogAttribute>;

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
      capture_console_errors: true,
    },
    logs: {
      ...serviceContext,
      captureConsoleLogs: false,
    },
    session_recording: {
      captureCanvas: {
        recordCanvas: true,
        canvasFps: 15,
      },
    },
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

export function logInfo(body: string, attributes?: Record<string, unknown>) {
  captureLog("info", body, attributes);
  if (attributes) console.info(body, attributes);
  else console.info(body);
}

export function logWarn(body: string, attributes?: Record<string, unknown>) {
  captureLog("warn", body, attributes);
  if (attributes) console.warn(body, attributes);
  else console.warn(body);
}

export function logError(body: string, attributes?: Record<string, unknown>) {
  captureLog("error", body, attributes);
  if (attributes) console.error(body, attributes);
  else console.error(body);
}

function captureLog(level: "info" | "warn" | "error", body: string, attributes?: Record<string, unknown>) {
  if (!POSTHOG_KEY) return;
  posthog.logger[level](body, normalizeLogAttributes(attributes));
}

function normalizeLogAttributes(attributes?: Record<string, unknown>): LogAttributes | undefined {
  if (!attributes) return undefined;
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, normalizeLogAttribute(value)]));
}

function normalizeLogAttribute(value: unknown): LogAttribute {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalizeLogAttribute(entry) ?? null);
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeLogAttribute(entry)]));
  }
  return String(value);
}

export { posthog };
