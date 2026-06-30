import type { DbConnection } from "../net/module_bindings";
import { captureEvent, logError, logInfo } from "../analytics.js";
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
export function mountAccount(
  conn: DbConnection,
  opts: { signedIn: boolean; authAvailable: boolean; claimFailed?: boolean },
): void {
  if (!opts.authAvailable) return;

  const root = document.createElement("div");
  root.className = "panel account";

  const status = document.createElement("div");
  status.className = "account-status";

  // We just came back from SpacetimeAuth without a usable token (the OIDC return
  // errored or the token exchange failed). Tell the player rather than silently
  // dropping them back on the claim button as if nothing happened.
  if (opts.claimFailed && !opts.signedIn) status.textContent = "Sign-in didn't complete. Try again.";

  const action = document.createElement("button");
  action.type = "button";
  action.className = "btn";
  action.textContent = opts.signedIn ? "Sign out" : "Claim account with Discord";
  action.addEventListener("click", async () => {
    if (opts.signedIn) {
      captureEvent("account_signed_out");
      logInfo("Account signed out", { surface: "account" });
      await signOut();
      window.location.reload();
      return;
    }
    action.disabled = true;
    status.textContent = "Starting sign-in...";
    const code = crypto.randomUUID();
    try {
      await conn.reducers.startClaim({ code });
    } catch (err) {
      logError("Account claim start failed", { surface: "account", action: "start_claim", error: err });
      status.textContent = "Couldn't start sign-in. Try again.";
      action.disabled = false;
      return;
    }
    setPendingClaim(code);
    captureEvent("account_claim_started");
    logInfo("Account claim started", { surface: "account" });
    try {
      await signIn();
    } catch (err) {
      logError("Sign-in redirect failed", { surface: "account", action: "sign_in_redirect", error: err });
      status.textContent = "Couldn't open sign-in. Try again.";
      action.disabled = false;
    }
  });

  root.append(action, status);
  hudRoot().appendChild(root);
}
