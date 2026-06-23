import type { Identity } from "spacetimedb";
import { DbConnection } from "./module_bindings";
import { SPACETIMEDB_DB_NAME, SPACETIMEDB_HOST } from "./env.js";
import { getStoredToken, storeToken } from "./identity.js";

/**
 * Connects to the SpacetimeDB module, presenting our stored connection token so
 * the server resumes our trogg (GDD "Identity"). A first-time browser gets a
 * fresh anonymous Identity and we store the token it returns; there's no
 * mint/verify round-trip — identity is the connection's own `ctx.sender`
 * server-side (invariant 3). Resolves once connected; the durable tables are
 * subscribed to by the world (see world.ts).
 */
export function connect(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(SPACETIMEDB_HOST)
      .withDatabaseName(SPACETIMEDB_DB_NAME)
      .withToken(getStoredToken() ?? undefined)
      .onConnect((conn: DbConnection, _identity: Identity, token: string) => {
        storeToken(token);
        resolve(conn);
      })
      .onConnectError((_ctx, error: Error) => reject(error))
      .build();
  });
}
