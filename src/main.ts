import { getZone, STARTING_ZONE_SLUG } from "@trogg/shared";
import { accountSubject, authConfigured, completeSignIn, currentIdToken } from "./auth.js";
import { captureEvent, identifyUser, initAnalytics, isFeatureEnabled, logError, logInfo } from "./analytics.js";
import { theme } from "./theme.js";
import { clearStoredToken, clearPendingClaim, getPendingClaim } from "./identity.js";
import { connect } from "./net/net.js";
import { mountAppearance } from "./ui/appearance.js";
import { mountCoach } from "./ui/coach.js";
import { mountGameMenu } from "./ui/menu.js";
import { mountWorldMap } from "./ui/worldmap.js";
import { mountInventory } from "./ui/inventory.js";
import { startReconnect } from "./net/reconnect.js";
import { watchForUpdate } from "./version.js";
import { StartGame } from "./game/main.js";

/** Narrate boot progress onto the play page's boot screen — when the game feels
 *  slow to open, the stage on screen names which phase is eating the time. */
function bootStage(text: string): void {
  const stage = document.getElementById("boot-stage");
  if (stage) stage.textContent = text;
}

async function main() {
  initAnalytics();

  try {
    // If this load is the redirect back from SpacetimeAuth, finish the exchange
    // before connecting so we can present the account's ID token (GDD "Identity").
    bootStage("checking identity…");
    const signInReturn = await completeSignIn();
    const idToken = await currentIdToken();

    // A failed OIDC return (provider error or token exchange failure) must not strand
    // the claim silently: drop the pending nonce so it can't retry-loop on every load,
    // and emit a visible failure event so a broken claim flow shows up as more than
    // just zero `player_named` events (docs/analytics.md). The game still boots below
    // as a guest — a failed claim degrades to the guest loop, it doesn't break the page.
    if (signInReturn === "error") {
      const hadPendingClaim = getPendingClaim() !== null;
      clearPendingClaim();
      captureEvent("account_claim_failed", { had_pending_claim: hadPendingClaim });
    }

    // A redeploy closes every live socket at once; recover automatically instead
    // of leaving players frozen on stale state until they refresh (reconnect.ts).
    bootStage("connecting…");
    const conn = await connect(idToken ?? undefined, () => startReconnect(idToken ?? undefined));
    const signedIn = idToken !== null;

    // Session lifecycle events are client-side; accepted gameplay actions emit from
    // SpacetimeDB procedure wrappers where server state is available (docs/analytics.md).
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

    // A newborn boots into its own instanced birth cave; everyone else into the
    // world (GDD "Onboarding: the Warren"). The player row's zone decides.
    bootStage("finding your cave…");
    let slug = STARTING_ZONE_SLUG;
    if (conn.identity) {
      const identity = conn.identity;
      await new Promise<void>((resolve) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => resolve())
          .subscribe([`SELECT * FROM player WHERE identity = 0x${identity.toHexString()}`]);
      });
      slug = conn.db.player.identity.find(identity)?.zoneId ?? STARTING_ZONE_SLUG;
    }

    captureEvent("player_joined", { zone: slug, is_guest: !signedIn });
    logInfo("Player joined world", { zone: slug, is_guest: !signedIn });

    // The coach listens for onboarding milestones; mount it before the world so
    // the first one (a newborn's "find the pickaxe", fired during world boot)
    // isn't dispatched into the void before its listener exists.
    mountCoach();

    // Three.js owns the canvas and the world render loop; StartGame boots the 3D
    // world with the live connection (game/main.ts, GDD "Camera and rendering").
    bootStage("entering the world…");
    const world = StartGame("game", { conn, slug });
    theme.start(); // the generative game theme (starts on the first user gesture)
    mountWorldMap({ zone: getZone(slug)!, selfPosition: () => world.selfPosition() });

    // HUD chrome is HTML overlaid on the canvas (hud.css); chat is mounted by
    // the scene since its speech bubbles live in the world. The game menu
    // (Escape) folds Help, Settings, and the account action into one modal.
    mountGameMenu({
      conn,
      signedIn,
      authAvailable: isFeatureEnabled("auth-enabled") && authConfigured(),
      claimFailed: signInReturn === "error",
    });
    // Appearance (name/colour/style) is for every player, no auth needed; it sits in the
    // top-left stack.
    mountAppearance(conn);
    if (conn.identity) mountInventory(conn, conn.identity.toHexString());

    // The frontend deploys separately from the backend (Cloudflare vs the VPS), so
    // a client-only deploy fires no socket disconnect — poll for it instead and
    // offer a refresh when newer assets ship (version.ts).
    watchForUpdate();
  } catch (err) {
    bootStage("couldn't reach the world — is the server up?");
    logError("Failed to connect to SpacetimeDB", { surface: "startup", action: "connect_spacetimedb", error: err });
  }
}

void main();
