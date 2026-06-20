import { Client, ErrorCode, MatchMakeError, type Room } from "@colyseus/sdk";
import { STARTING_ZONE_SLUG, type ZoneState } from "@trogg/shared";
import { COLYSEUS_URL } from "./env.js";
import { getStoredGuestToken, storeGuestToken } from "./identity.js";

/**
 * Joins the room for a zone (the starting zone by default), presenting our
 * signed guest credential so the server can resume our trogg (GDD "Identity").
 * A first-time browser mints a credential; a stored one rejected by the server
 * (e.g. it restarted with a new key) is replaced with a fresh identity and we
 * retry once. The `zone` option routes us to that zone's room (see server
 * index.ts). State is decoded from the schema reflection the server sends on
 * join, so no schema classes cross the wire — the type is for us only.
 */
export async function joinZone(slug: string = STARTING_ZONE_SLUG): Promise<Room<ZoneState>> {
  const client = new Client(COLYSEUS_URL);

  const stored = getStoredGuestToken();
  if (stored) {
    try {
      return await join(client, stored, slug);
    } catch (err) {
      if (!isAuthRejection(err)) throw err;
      console.warn("Stored guest credential rejected — minting a new trogg.");
    }
  }

  const token = await mintGuestToken(client);
  storeGuestToken(token);
  return join(client, token, slug);
}

async function join(client: Client, token: string, slug: string): Promise<Room<ZoneState>> {
  client.auth.token = token;
  return client.joinOrCreate<ZoneState>("zone", { zone: slug });
}

async function mintGuestToken(client: Client): Promise<string> {
  const { data } = await client.http.post("/auth/guest", {});
  return (data as { token: string }).token;
}

/** True only when the server actively refused the credential, not on a network blip. */
function isAuthRejection(err: unknown): boolean {
  return err instanceof MatchMakeError && err.code === ErrorCode.AUTH_FAILED;
}
