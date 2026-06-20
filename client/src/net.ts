import { Client, type Room } from "@colyseus/sdk";
import { STARTING_ZONE_SLUG, type ZoneState } from "@trogg/shared";
import { COLYSEUS_URL } from "./env.js";
import { getOrCreateGuestId } from "./identity.js";

/**
 * Joins the room for a zone (the starting zone by default), passing the
 * browser-stored guest id so the server can resume our trogg. The `zone` option
 * routes us to that zone's room (see server index.ts). State is decoded from the
 * schema reflection the server sends on join, so no schema classes cross the
 * wire — the type is for us only.
 */
export async function joinZone(slug: string = STARTING_ZONE_SLUG): Promise<Room<ZoneState>> {
  const client = new Client(COLYSEUS_URL);
  return client.joinOrCreate<ZoneState>("zone", { userId: getOrCreateGuestId(), zone: slug });
}
