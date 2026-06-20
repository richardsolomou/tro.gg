import { Client, type Room } from "colyseus.js";
import type { ZoneState } from "@tro/shared";
import { COLYSEUS_URL } from "./env.js";

/**
 * Joins the zone room. State is decoded from the schema reflection the server
 * sends on join, so no schema classes cross the wire — the type is for us only.
 */
export async function joinZone(): Promise<Room<ZoneState>> {
  const client = new Client(COLYSEUS_URL);
  return client.joinOrCreate<ZoneState>("zone");
}
