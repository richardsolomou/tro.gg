import { Application } from "pixi.js";
import { initAnalytics } from "./analytics.js";
import { joinZone } from "./net.js";
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
    const room = await joinZone();
    mountWorld(app, room);
  } catch (err) {
    console.error("Failed to join zone:", err);
  }
}

void main();
