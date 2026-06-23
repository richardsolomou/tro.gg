const STORAGE_KEY = "tro.gg:authToken";

/**
 * The browser's half of guest identity (GDD "Identity"): the connection token
 * SpacetimeDB issued for our anonymous Identity. We store it and present it on
 * the next connection so a returning visitor resumes the same trogg. Only the
 * token lives here — the durable game state stays server-authoritative
 * (invariant 3). Clearing the browser drops it and makes a new trogg;
 * cross-device sign-in (a real account) is the next slice of M1.
 */
export function getStoredToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}
