import { captureEvent, logInfo, logWarn } from "../analytics.js";
import { connect } from "./net.js";

/**
 * Keeps players in the world across a server redeploy. SpacetimeDB is both the
 * durable store and the live feed (GDD), so publishing a new module version closes
 * every live socket at once. Without this the client just freezes on stale state
 * and the player has to refresh by hand — which reads as "everyone got logged
 * out". Instead we surface a quiet "reconnecting" overlay and probe for the server
 * to come back with exponential backoff + full jitter. Jitter is the point: the
 * whole world drops simultaneously on deploy, so a synchronized retry would
 * stampede the instance the moment it restarts.
 *
 * Once a probe connects we reload rather than re-wire the live connection: every
 * table is server-authoritative and re-derived from subscriptions on connect, and
 * the stored Identity token resumes the same trogg (GDD "Guest persistence"), so a
 * clean reload loses nothing and avoids rebuilding every subscription and Phaser
 * object by hand. Nothing is orphaned — the server settles the trogg on disconnect
 * (GDD invariant 1).
 */

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 20_000;

let active = false;

/**
 * Begin recovering after the live connection drops. Idempotent — repeated drops
 * (or a flaky network during recovery) won't stack overlays or probe loops.
 * `accountToken` is the same credential `main` connected with, so a signed-in
 * player probes as their account rather than spinning up a throwaway guest.
 */
export function startReconnect(accountToken?: string): void {
  if (active) return;
  active = true;
  captureEvent("connection_lost");
  logWarn("SpacetimeDB connection lost", { surface: "reconnect" });
  showOverlay();
  void probeUntilLive(accountToken);
}

async function probeUntilLive(accountToken?: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await sleep(backoffWithJitter(attempt));
    try {
      const conn = await connect(accountToken);
      // The probe only proves the server is back; the reload makes the real
      // connection with a clean slate, so drop this one rather than leak it.
      conn.disconnect();
      logInfo("SpacetimeDB reconnect probe succeeded", { surface: "reconnect", attempt });
      window.location.reload();
      return;
    } catch {
      logWarn("SpacetimeDB reconnect probe failed", { surface: "reconnect", attempt });
      // Server still unreachable (mid-deploy) — keep backing off and retry.
    }
  }
}

/** Exponential ceiling, then "full jitter" across the whole [0, ceiling] window. */
function backoffWithJitter(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let overlay: HTMLElement | null = null;

/**
 * A DOM overlay, not a canvas node: the renderer keeps running on stale state after
 * a drop, so a plain element on top is the reliable way to tell the player we're
 * working on it. Styled inline because the play page (play/index.html) ships no
 * stylesheet of its own.
 */
function showOverlay(): void {
  if (overlay) return;
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.textContent = "reconnecting…";
  Object.assign(el.style, {
    position: "fixed",
    inset: "0",
    display: "grid",
    placeItems: "center",
    background: "rgba(10, 8, 6, 0.82)",
    color: "#e8dcc4",
    font: "20px monospace",
    letterSpacing: "0.12em",
    zIndex: "9999",
    pointerEvents: "none",
  });
  document.body.appendChild(el);
  overlay = el;
}
