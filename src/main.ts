import { Application } from "pixi.js";
import { STARTING_ZONE_SLUG } from "@trogg/shared";
import { captureEvent, initAnalytics } from "./analytics.js";
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
    const conn = await connect();
    // Server-authoritative events can't be emitted from inside reducers
    // (network-isolated), so session events fire client-side (docs/analytics.md).
    captureEvent("player_joined", { zone: STARTING_ZONE_SLUG, is_guest: true });
    await mountWorld(app, conn);
  } catch (err) {
    console.error("Failed to connect to SpacetimeDB:", err);
  }
}

void main();
