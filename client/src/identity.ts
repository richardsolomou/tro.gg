const STORAGE_KEY = "tro.gg:guestToken";

/**
 * The browser's half of guest identity (GDD "Identity"): a signed credential the
 * server issued and we replay on join so a returning visitor resumes the same
 * trogg. Only the token lives here — the durable game state stays
 * server-authoritative (invariant 3). Clearing the browser drops it and makes a
 * new trogg; cross-device sign-in (a real account) is the next slice of M1.
 */
export function getStoredGuestToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function storeGuestToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
}
