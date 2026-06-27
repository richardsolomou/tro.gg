import type { DbConnection } from "../net/module_bindings";
import { signIn, signOut } from "../auth.js";
import { setPendingClaim } from "../identity.js";
import { hudRoot } from "./hud.js";

/**
 * The account panel (GDD "Identity") as a small top-right HTML overlay: just the
 * claim/sign-out control. Your name lives in the top-left Appearance panel — along
 * with recolour and restyle — so this panel doesn't repeat it. Nothing to show
 * without SpacetimeAuth configured (the only action is claiming an account), so it
 * renders only when auth is available.
 */
export function mountAccount(conn: DbConnection, opts: { signedIn: boolean; authAvailable: boolean }): void {
  if (!opts.authAvailable) return;

  const root = document.createElement("div");
  root.className = "panel account";

  const status = document.createElement("div");
  status.className = "account-status";

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

  root.append(action, status);
  hudRoot().appendChild(root);
}
