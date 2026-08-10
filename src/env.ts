/** WebSocket URL of the SpacetimeDB instance, and the module (database) name. */
export const SPACETIMEDB_HOST = import.meta.env.VITE_SPACETIMEDB_HOST ?? "ws://localhost:3001";
export const SPACETIMEDB_DB_NAME = import.meta.env.VITE_SPACETIMEDB_DB_NAME ?? "trogg";

/** PostHog project key. Telemetry is a no-op when unset (e.g. local dev). */
export const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
export const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";

/**
 * SpacetimeAuth (GDD "Identity") — the OIDC provider that backs account sign-in.
 * The browser runs an Authorization-Code-+-PKCE flow, so there is **no client
 * secret** in this bundle (invariant 8). Accounts are disabled when the client id
 * is unset, keeping the guest-only loop working with no auth config (local dev).
 * The issuer is fixed in `shared` (the module trusts only it); only the client id
 * and redirect URI are per-deployment.
 *
 * The redirect URI has **no trailing slash** and must not grow one. Production
 * serves the game at `/play/` and 307s `/play` onto it, which reads like a
 * mismatch and has been "fixed" once already — but `/play` is what is registered
 * with SpacetimeAuth, and `/play/` is rejected outright at the authorize step. The
 * extra hop is harmless: the redirect carries `?code=&state=` through untouched.
 */
export const SPACETIMEAUTH_CLIENT_ID = import.meta.env.VITE_SPACETIMEAUTH_CLIENT_ID as string | undefined;
export const SPACETIMEAUTH_REDIRECT_URI =
  (import.meta.env.VITE_SPACETIMEAUTH_REDIRECT_URI as string | undefined) ?? `${window.location.origin}/play`;
