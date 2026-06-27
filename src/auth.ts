import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { SPACETIMEAUTH_ISSUER } from "@trogg/shared";
import { logError } from "./analytics.js";
import { SPACETIMEAUTH_CLIENT_ID, SPACETIMEAUTH_REDIRECT_URI } from "./env.js";

/**
 * Account sign-in via SpacetimeAuth (GDD "Identity"). SpacetimeDB derives a stable
 * Identity from an OIDC token's `iss`+`sub`, so signing in lets a player log back
 * into the same trogg on any device. We run the Authorization-Code-+-PKCE flow in
 * the browser — a public client, so **no secret ships in the bundle** (invariant
 * 8). The ID token is what the SpacetimeDB connection authenticates with; this
 * module is the only place that flow lives.
 *
 * Accounts are disabled (every call a no-op) when no client id is configured, so
 * the guest-only loop runs with zero auth setup (local dev).
 */
let manager: UserManager | null | undefined;

function userManager(): UserManager | null {
  if (manager === undefined) {
    manager = SPACETIMEAUTH_CLIENT_ID
      ? new UserManager({
          authority: SPACETIMEAUTH_ISSUER,
          client_id: SPACETIMEAUTH_CLIENT_ID,
          redirect_uri: SPACETIMEAUTH_REDIRECT_URI,
          response_type: "code",
          // openid+profile for the username claim; offline_access for a refresh
          // token so we can mint a fresh ID token to reconnect with, no iframe.
          scope: "openid profile offline_access",
          automaticSilentRenew: true,
          userStore: new WebStorageStateStore({ store: window.localStorage }),
        })
      : null;
  }
  return manager;
}

/** Whether account sign-in is configured in this build (else guest-only). */
export function authConfigured(): boolean {
  return userManager() !== null;
}

/** Begin the OIDC redirect to SpacetimeAuth (Discord). The browser navigates away. */
export async function signIn(): Promise<void> {
  const m = userManager();
  if (!m) throw new Error("SpacetimeAuth is not configured");
  await m.signinRedirect();
}

/**
 * If this load is the redirect back from SpacetimeAuth (`?code=&state=` present),
 * complete the token exchange and strip the params so a refresh can't replay the
 * spent code. Returns whether a sign-in just completed. Safe to call every load.
 */
export async function completeSignIn(): Promise<boolean> {
  const m = userManager();
  if (!m) return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("code") || !params.has("state")) return false;
  await m.signinRedirectCallback();
  window.history.replaceState({}, "", window.location.pathname);
  return true;
}

/**
 * A non-expired SpacetimeAuth ID token to connect with, silently refreshing via
 * the refresh token when stale, or null if not signed in. This is the credential
 * passed to the SpacetimeDB connection.
 */
export async function currentIdToken(): Promise<string | null> {
  const m = userManager();
  if (!m) return null;
  let user = await m.getUser();
  if (user?.expired) {
    user = await m.signinSilent().catch((err: unknown) => {
      logError("SpacetimeAuth silent token refresh failed", { surface: "auth", action: "silent_renew", error: err });
      return null;
    });
  }
  return user?.id_token ?? null;
}

/** The account's stable subject claim (`sub`) — the canonical id for `identify()`. */
export async function accountSubject(): Promise<string | null> {
  const m = userManager();
  const user = m ? await m.getUser() : null;
  return user?.profile.sub ?? null;
}

/** Forget the account session (the player becomes a fresh guest on the next load). */
export async function signOut(): Promise<void> {
  await userManager()?.removeUser();
}
