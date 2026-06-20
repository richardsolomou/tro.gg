import "dotenv/config";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { RedisPresence } from "@colyseus/redis-presence";
import { RedisDriver } from "@colyseus/redis-driver";
import { ZoneRoom } from "./rooms/ZoneRoom.js";
import { getGameStore } from "./persistence/gameStore.js";

const port = Number(process.env.PORT ?? 2567);
const redisUrl = process.env.REDIS_URL;

// The transport owns the Express app that serves the matchmaking routes; we add
// ours through this callback. The client runs on a different origin (Cloudflare
// Pages) and sends credentialed matchmaking requests, so CORS must reflect the
// origin and allow credentials. Lock CLIENT_ORIGIN down in production.
//
// With REDIS_URL set, matchmaking presence and the room driver live in Redis —
// the same store backing the player cache, mirroring prod. Without it, Colyseus
// falls back to its in-memory presence/driver (fine for a single dev process).
// Running multiple processes is deferred scaling work (invariant 10); this is
// the parity plumbing, not a horizontal scale-out.
const gameServer = new Server({
  transport: new WebSocketTransport(),
  ...(redisUrl ? { presence: new RedisPresence(redisUrl), driver: new RedisDriver(redisUrl) } : {}),
  express: (app) => {
    app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? true, credentials: true }));
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
  },
});

// One room per zone: filtering by the `zone` option means a join request for a
// given slug only matches a room hosting that zone, so each zone gets its own
// room (GDD "Multiplayer scaling stance"). M0 has one zone; the routing is ready
// for more.
gameServer.define("zone", ZoneRoom).filterBy(["zone"]);

async function main() {
  const store = getGameStore();
  await store.init();
  if (!store.persistent) {
    console.warn("No DATABASE_URL or REDIS_URL set — running with in-memory state only.");
  }

  await gameServer.listen(port);
  console.log(`tro.gg server listening on :${port}`);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

// A crash in a room handler or the transport would otherwise die with no stack.
// Log it and exit so the supervisor (tsx watch / systemd) restarts cleanly.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});
