import { Application } from "pixi.js";
import { STARTING_ZONE_SLUG } from "@trogg/shared";
import { mountAccount } from "./account.js";
import { accountSubject, authConfigured, completeSignIn, currentIdToken } from "./auth.js";
import { captureEvent, identifyUser, initAnalytics, isFeatureEnabled } from "./analytics.js";
import { clearStoredToken, clearPendingClaim, getPendingClaim } from "./identity.js";
import { connect } from "./net.js";
import { mountWorld } from "./world.js";

async function main() {
  initAnalytics();

  const app = new Application();
  await app.init({
    background: "#0a0806",
    resizeTo: window,
    antialias: false,
    roundPixels: true,
  });
  document.getElementById("game")!.appendChild(app.canvas);

  try {
    // If this load is the redirect back from SpacetimeAuth, finish the exchange
    // before connecting so we can present the account's ID token (GDD "Identity").
    await completeSignIn();
    const idToken = await currentIdToken();

    const conn = await connect(idToken ?? undefined);
    const signedIn = idToken !== null;

    // Server-authoritative events can't be emitted from inside reducers
    // (network-isolated), so session events fire client-side (docs/analytics.md).
    captureEvent("player_joined", { zone: STARTING_ZONE_SLUG, is_guest: !signedIn });

    // Complete a pending claim: we signed in to upgrade a guest, so redeem the
    // nonce now that we're connected as the account. This folds the guest trogg in
    // and marks the account named — fire `player_named` alongside `identify()` so
    // PostHog merges the guest's history onto the account (docs/analytics.md).
    if (signedIn) {
      const pending = getPendingClaim();
      if (pending) {
        await conn.reducers.redeemClaim({ code: pending });
        clearPendingClaim();
        clearStoredToken(); // the guest row is absorbed; never resume it
        const subject = await accountSubject();
        if (subject) identifyUser(subject);
        captureEvent("player_named");
      }
    }

    mountWorld(app, conn);
    // Account UI (rename + claim) is behind an optional rollout flag and only
    // mounts when SpacetimeAuth is configured for this build.
    if (authConfigured() && isFeatureEnabled("auth-enabled")) mountAccount(conn, { signedIn });
  } catch (err) {
    console.error("Failed to connect to SpacetimeDB:", err);
  }
}

void main();
