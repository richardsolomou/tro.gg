import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { SPACETIMEAUTH_ISSUER } from "@trogg/shared";
import { captureEvent, logError, logWarn } from "./analytics.js";
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
          // With no refresh token the renew falls back to an iframe, and
          // `silent_redirect_uri` defaults to `redirect_uri` — this page. That is
          // handled, not assumed away: see `completeSilentSignIn`.
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
 * The outcome of handling a load that may be the redirect back from SpacetimeAuth:
 * `none` (not a return), `success` (a sign-in just completed), or `error` (the
 * provider returned an error, or the token exchange failed). The error case must be
 * a distinct, observable outcome — not a silent `none` — or a misconfigured redirect
 * URI / client makes the whole claim flow fail invisibly (the 2026-06 regression).
 */
export type SignInReturn = "none" | "success" | "error";

/**
 * If this load is the redirect back from SpacetimeAuth, complete the token exchange
 * and strip the OIDC params so a refresh can't replay the spent code (or re-trigger
 * the error). Returns `success`/`error`/`none`; never throws. Safe to call every load.
 *
 * A failed return is reported, not swallowed: SpacetimeAuth can come back with
 * `?error=…` (e.g. `redirect_uri` mismatch, bad client, denied consent) instead of
 * `?code=&state=`, and `signinRedirectCallback` itself can reject when the token
 * exchange fails — both used to look identical to "nobody signed in", so a broken
 * claim flow showed up only as zero `player_named` events with no error trail.
 *
 * This handles the *top-level* return only. A silent renew's response lands on this
 * same page inside a hidden frame and is answered by `completeSilentSignIn` first.
 */
export async function completeSignIn(): Promise<SignInReturn> {
  const m = userManager();
  if (!m) return "none";
  if (!isOidcReturn(window.location.search)) return "none";
  const params = new URLSearchParams(window.location.search);

  // Strip the OIDC params whatever the outcome, so a refresh can't replay a spent
  // code or re-surface a stale error in the URL.
  const stripParams = () => window.history.replaceState({}, "", window.location.pathname);

  if (params.has("error")) {
    logError("SpacetimeAuth sign-in returned an error", {
      surface: "auth",
      action: "complete_sign_in",
      error: params.get("error"),
      error_description: params.get("error_description"),
    });
    stripParams();
    return "error";
  }

  try {
    await m.signinRedirectCallback();
    stripParams();
    return "success";
  } catch (err) {
    logError("SpacetimeAuth token exchange failed", { surface: "auth", action: "complete_sign_in", error: err });
    stripParams();
    return "error";
  }
}

/** Whether a page's query string carries an OIDC authorization response. */
function isOidcReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  return (params.has("code") && params.has("state")) || params.has("error");
}

/**
 * Whether this document is the hidden iframe a silent token renew loads its
 * response into. `silent_redirect_uri` defaults to `redirect_uri` — the game page
 * — so the renew's authorization response comes back to *this* module, in a 0×0
 * frame, looking exactly like a fresh top-level sign-in.
 */
function isSilentRenewFrame(): boolean {
  return window.self !== window.top && isOidcReturn(window.location.search);
}

/**
 * If this load is a silent token renew's response, hand it to the parent window and
 * report `true` — the caller must then stop, without booting the game.
 *
 * Treating a renew like a top-level return is what broke durable accounts: the
 * renew iframe ran the whole page (a second analytics session, a second SpacetimeDB
 * connection, a hidden 3D world), cleared the real tab's pending-claim nonce out of
 * the `sessionStorage` they share, and reported a bogus `account_claim_failed` —
 * while the parent's `signinSilent()` waited out its ten-second timeout for a
 * message only `signinSilentCallback` sends, then gave up and dropped the account
 * back to a guest. `signinCallback` dispatches on the request type recorded when the
 * flow started, so each kind of return reaches the handler that finishes it.
 */
export async function completeSilentSignIn(): Promise<boolean> {
  const m = userManager();
  if (!m || !isSilentRenewFrame()) return false;
  try {
    await m.signinCallback();
  } catch {
    // There is no one to tell from inside a hidden frame, and analytics is not up
    // yet. The parent's `signinSilent()` rejects and `currentIdToken` reports it.
  }
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
  const hadSession = user !== null;
  if (user?.expired) {
    user = await m.signinSilent().catch((err: unknown) => {
      logError("SpacetimeAuth silent token refresh failed", { surface: "auth", action: "silent_renew", error: err });
      return null;
    });
  }
  const token = user?.id_token ?? null;
  // A stored account session that yields no token is the worst outcome this flow
  // has: the player is about to boot as a guest, and the guest token they had
  // before claiming was cleared when the claim landed, so they get a *new* trogg
  // rather than their old one. It has to be its own event — from the outside it
  // is indistinguishable from a first-time visitor, which is how a dead claim
  // flow hid behind "zero `player_named`" for weeks (docs/analytics.md).
  if (hadSession && !token) {
    captureEvent("account_session_lapsed");
    logWarn("Account session lapsed; continuing as a guest", { surface: "auth", action: "current_id_token" });
  }
  return token;
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
