import { Client, type Room } from "@colyseus/sdk";
import type { ZoneState } from "@trogg/shared";
import { COLYSEUS_URL } from "./env.js";
import { getOrCreateGuestId } from "./identity.js";

/**
 * Joins the zone room, passing the browser-stored guest id so the server can
 * resume our trogg. State is decoded from the schema reflection the server
 * sends on join, so no schema classes cross the wire — the type is for us only.
 */
export async function joinZone(): Promise<Room<ZoneState>> {
  const client = new Client(COLYSEUS_URL);
  return client.joinOrCreate<ZoneState>("zone", { userId: getOrCreateGuestId() });
}
