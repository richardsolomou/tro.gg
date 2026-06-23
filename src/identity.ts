const STORAGE_KEY = "tro.gg:authToken";
const CLAIM_KEY = "tro.gg:claimCode";

/**
 * The browser's half of guest identity (GDD "Identity"): the connection token
 * SpacetimeDB issued for our anonymous Identity. We store it and present it on
 * the next connection so a returning visitor resumes the same trogg. Only the
 * token lives here — the durable game state stays server-authoritative
 * (invariant 3). Clearing the browser drops it and makes a new trogg. Account
 * sign-in (cross-device) is handled separately by the OIDC layer (see auth.ts);
 * its tokens are never stored as this guest token.
 */
export function getStoredToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}

/** Forget the guest token — used once a guest is folded into an account, so we never resume the now-absorbed trogg. */
export function clearStoredToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * A pending account claim (GDD "Identity"): the one-time nonce the guest minted
 * and registered via `startClaim`, held across the OAuth redirect so we can
 * `redeemClaim` it once we return signed in. `sessionStorage` survives the
 * top-level redirect within the tab but not a fresh tab, scoping the nonce to the
 * browser session that started the claim.
 */
export function setPendingClaim(code: string): void {
  sessionStorage.setItem(CLAIM_KEY, code);
}

export function getPendingClaim(): string | null {
  return sessionStorage.getItem(CLAIM_KEY);
}

export function clearPendingClaim(): void {
  sessionStorage.removeItem(CLAIM_KEY);
}
