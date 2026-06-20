import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { RedisPresence } from "@colyseus/redis-presence";
import { RedisDriver } from "@colyseus/redis-driver";
import { ZoneRoom } from "./rooms/ZoneRoom.js";
import { getGameStore } from "./persistence/gameStore.js";

const port = Number(process.env.PORT ?? 2567);
const redisUrl = process.env.REDIS_URL;

// The client runs on a different origin (Cloudflare Pages), so matchmaking
// (HTTP) needs permissive CORS. Lock CLIENT_ORIGIN down in production.
const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? true }));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);

// With REDIS_URL set, matchmaking presence and the room driver live in Redis —
// the same store backing the player cache, mirroring prod. Without it, Colyseus
// falls back to its in-memory presence/driver (fine for a single dev process).
// Running multiple processes is deferred scaling work (invariant 10); this is
// the parity plumbing, not a horizontal scale-out.
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  ...(redisUrl ? { presence: new RedisPresence(redisUrl), driver: new RedisDriver(redisUrl) } : {}),
});

gameServer.define("zone", ZoneRoom);

async function main() {
  const store = getGameStore();
  await store.init();
  if (!store.persistent) {
    console.warn("No DATABASE_URL or REDIS_URL set — running with in-memory state only.");
  }

  httpServer.listen(port, () => {
    console.log(`tro.gg server listening on :${port}`);
  });
}

void main();
