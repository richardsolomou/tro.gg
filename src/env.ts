/** WebSocket URL of the SpacetimeDB instance, and the module (database) name. */
export const SPACETIMEDB_HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? "ws://localhost:3000";
export const SPACETIMEDB_DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? "trogg";

/** PostHog project key. Telemetry is a no-op when unset (e.g. local dev). */
export const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
export const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";
