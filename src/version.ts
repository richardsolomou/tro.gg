import { captureEvent, logInfo } from "./analytics.js";

/**
 * Notices when a newer frontend has been deployed and offers the player a refresh.
 *
 * The client (Cloudflare) and the SpacetimeDB module (VPS) ship separately, so a
 * frontend-only deploy leaves the live socket untouched — reconnect.ts never fires
 * and the player would otherwise run the old bundle until they refreshed by hand.
 * There's no push for "new assets are live", so we poll: each build is stamped with
 * `__BUILD_ID__` and ships a matching `version.json` (see vite.config.ts), and we
 * compare the deployed stamp against the one compiled into this running client.
 *
 * On a mismatch we *prompt* rather than force-reload: the old client keeps working
 * against the unchanged backend, so there's no urgency to interrupt an in-progress
 * action — the player refreshes when it suits them.
 */

const POLL_MS = 60_000;

let prompted = false;

/** Start watching for a newer deployed build. Safe to call once after the world mounts. */
export function watchForUpdate(): void {
  const check = (): void => void checkVersion();
  setInterval(check, POLL_MS);
  // Re-check the moment the player returns to the tab — that's both when a stale
  // build matters most and when an idle tab is most likely to have missed a deploy.
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
}

async function checkVersion(): Promise<void> {
  if (prompted) return;
  let deployed: string | undefined;
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return;
    deployed = ((await res.json()) as { build?: string }).build;
  } catch {
    // Offline, or dev where version.json isn't built — nothing to do.
    return;
  }
  if (!deployed || deployed === __BUILD_ID__) return;
  prompted = true;
  captureEvent("client_update_available");
  logInfo("Client update available", { current_build: __BUILD_ID__, deployed_build: deployed });
  showUpdateBanner();
}

/**
 * A dismissible DOM banner (not a canvas node, so it shows even if the renderer is
 * busy). Inline-styled because the play page ships no stylesheet of its own.
 */
function showUpdateBanner(): void {
  const bar = document.createElement("div");
  bar.setAttribute("role", "status");
  Object.assign(bar.style, {
    position: "fixed",
    left: "50%",
    bottom: "24px",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: "14px",
    padding: "10px 14px",
    background: "rgba(10, 8, 6, 0.92)",
    color: "#e8dcc4",
    font: "16px monospace",
    border: "1px solid #4a3826",
    borderRadius: "6px",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.5)",
    zIndex: "9999",
  });

  const label = document.createElement("span");
  label.textContent = "A new version of tro.gg is ready.";

  const refresh = document.createElement("button");
  refresh.textContent = "Refresh";
  Object.assign(refresh.style, {
    font: "16px monospace",
    color: "#0a0806",
    background: "#ff8c2e",
    border: "none",
    borderRadius: "4px",
    padding: "5px 12px",
    cursor: "pointer",
  });
  refresh.addEventListener("click", () => window.location.reload());

  const dismiss = document.createElement("button");
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", "Dismiss");
  Object.assign(dismiss.style, {
    font: "16px monospace",
    color: "#9b8a6c",
    background: "transparent",
    border: "none",
    cursor: "pointer",
  });
  dismiss.addEventListener("click", () => bar.remove());

  bar.append(label, refresh, dismiss);
  document.body.appendChild(bar);
}
