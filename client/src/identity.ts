const STORAGE_KEY = "tro.gg:guestId";

/**
 * The browser-stored guest id, generated once and reused so a returning visitor
 * resumes the same trogg (GDD "Identity"). This is the local half of guest
 * persistence — the durable game state stays server-authoritative (invariant 3).
 * M1 upgrades this to a signed credential validated server-side.
 */
export function getOrCreateGuestId(): string {
  let id = localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
