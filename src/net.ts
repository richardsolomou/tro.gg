import type { Identity } from "spacetimedb";
import { DbConnection } from "./module_bindings";
import { SPACETIMEDB_DB_NAME, SPACETIMEDB_HOST } from "./env.js";
import { getStoredToken, storeToken } from "./identity.js";

/**
 * Connects to the SpacetimeDB module (GDD "Identity"). With no `accountToken`, we
 * present our stored guest token so the server resumes our anonymous trogg — a
 * first-time browser gets a fresh Identity and we store the token it returns.
 * With an `accountToken` (a SpacetimeAuth ID token), we connect as that account
 * instead; the server derives a stable Identity from its `iss`+`sub`. Either way
 * identity is the connection's own `ctx.sender` server-side (invariant 3); there's
 * no mint/verify round-trip. We only ever persist the *guest* token — the account
 * credential is the OIDC session, owned by auth.ts. Resolves once connected.
 *
 * `onDisconnect` fires when an established connection drops — most often because a
 * new module version was just published, which closes every live socket at once.
 * It is *not* invoked on a failed initial connect (that rejects the promise via
 * `onConnectError`), so callers can treat it purely as "we were in, now we're out"
 * (see reconnect.ts).
 */
export function connect(accountToken?: string, onDisconnect?: () => void): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(SPACETIMEDB_HOST)
      .withDatabaseName(SPACETIMEDB_DB_NAME)
      .withToken(accountToken ?? getStoredToken() ?? undefined)
      .onConnect((conn: DbConnection, _identity: Identity, token: string) => {
        if (!accountToken) storeToken(token);
        resolve(conn);
      })
      .onConnectError((_ctx, error: Error) => reject(error))
      .onDisconnect(() => onDisconnect?.())
      .build();
  });
}
