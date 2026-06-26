import { Application } from "pixi.js";
import { STARTING_ZONE_SLUG } from "@trogg/shared";
import { mountAccount } from "./account.js";
import { accountSubject, authConfigured, completeSignIn, currentIdToken } from "./auth.js";
import { captureEvent, identifyUser, initAnalytics, isFeatureEnabled } from "./analytics.js";
import { clearStoredToken, clearPendingClaim, getPendingClaim } from "./identity.js";
import { connect } from "./net.js";
import { startReconnect } from "./reconnect.js";
import { watchForUpdate } from "./version.js";
import { mountWorld } from "./world.js";

async function main() {
  initAnalytics();

  const app = new Application();
  await app.init({
    background: "#0a0806",
    resizeTo: window,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    antialias: false,
    roundPixels: true,
  });
  document.getElementById("game")!.appendChild(app.canvas);

  try {
    // If this load is the redirect back from SpacetimeAuth, finish the exchange
    // before connecting so we can present the account's ID token (GDD "Identity").
    await completeSignIn();
    const idToken = await currentIdToken();

    // A redeploy closes every live socket at once; recover automatically instead
    // of leaving players frozen on stale state until they refresh (reconnect.ts).
    const conn = await connect(idToken ?? undefined, () => startReconnect(idToken ?? undefined));
    const signedIn = idToken !== null;

    // Server-authoritative events can't be emitted from inside reducers
    // (network-isolated), so session events fire client-side (docs/analytics.md).
    captureEvent("player_joined", { zone: STARTING_ZONE_SLUG, is_guest: !signedIn });

    if (signedIn) {
      // Complete a pending claim: we signed in to upgrade a guest, so redeem the nonce now
      // that we're connected as the account. This folds the guest trogg in and marks the
      // account named (docs/analytics.md).
      const pending = getPendingClaim();
      if (pending) {
        await conn.reducers.redeemClaim({ code: pending });
        clearPendingClaim();
        clearStoredToken(); // the guest row is absorbed; never resume it
        captureEvent("player_named");
      }
      // Associate this session with the account's stable subject whether or not a claim
      // was pending — a fresh-device sign-in (no guest to claim) must still `identify()`
      // so PostHog merges the account's sessions across devices (docs/analytics.md).
      const subject = await accountSubject();
      if (subject) identifyUser(subject);
    }

    mountWorld(app, conn);
    // The frontend deploys separately from the backend (Cloudflare vs the VPS), so
    // a client-only deploy fires no socket disconnect — poll for it instead and
    // offer a refresh when newer assets ship (version.ts).
    watchForUpdate();
    // Account UI owns rename/recolour for every player. Claim/sign-in controls only
    // appear when SpacetimeAuth is configured for this build.
    if (isFeatureEnabled("auth-enabled")) mountAccount(app, conn, { signedIn, authAvailable: authConfigured() });
  } catch (err) {
    console.error("Failed to connect to SpacetimeDB:", err);
  }
}

void main();
