import type { DbConnection } from "../net/module_bindings";
import { signIn, signOut } from "../auth.js";
import { setPendingClaim } from "../identity.js";
import { hudRoot } from "./hud.js";

/**
 * The account panel (GDD "Identity") as a small top-right HTML overlay: who you
 * are, and the claim/sign-out control when SpacetimeAuth is configured. Renaming,
 * recolouring, and restyling moved to the top-left Appearance panel — everything
 * about how your trogg *looks* lives there; this panel is only the account itself.
 * Mounted only when `auth-enabled`, since with no auth there's nothing to claim.
 */
export function mountAccount(conn: DbConnection, opts: { signedIn: boolean; authAvailable: boolean }): void {
  const myId = conn.identity?.toHexString();
  const myName = () => (conn.identity ? (conn.db.player.identity.find(conn.identity)?.name ?? "") : "");

  const root = document.createElement("div");
  root.className = "panel account";

  const who = document.createElement("div");
  const status = document.createElement("div");
  status.className = "account-status";
  root.append(who, status);

  if (opts.authAvailable) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn";
    action.textContent = opts.signedIn ? "Sign out" : "Claim account with Discord";
    action.addEventListener("click", async () => {
      if (opts.signedIn) {
        await signOut();
        window.location.reload();
        return;
      }
      action.disabled = true;
      status.textContent = "Starting sign-in…";
      const code = crypto.randomUUID();
      try {
        await conn.reducers.startClaim({ code });
      } catch {
        status.textContent = "Couldn't start sign-in. Try again.";
        action.disabled = false;
        return;
      }
      setPendingClaim(code);
      await signIn();
    });
    root.appendChild(action);
  }

  hudRoot().appendChild(root);

  const refresh = () => {
    const name = myName();
    who.textContent = name ? `You are ${name}` : "Connecting…";
  };

  conn.db.player.onInsert((_ctx, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });
  conn.db.player.onUpdate((_ctx, _old, p) => {
    if (p.identity.toHexString() === myId) refresh();
  });

  refresh();
}
