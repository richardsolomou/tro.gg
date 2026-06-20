import "dotenv/config";
import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ZoneRoom } from "./rooms/ZoneRoom.js";

const port = Number(process.env.PORT ?? 2567);

// The client runs on a different origin (Cloudflare Pages), so matchmaking
// (HTTP) needs permissive CORS. Lock CLIENT_ORIGIN down in production.
const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? true }));
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("zone", ZoneRoom);

httpServer.listen(port, () => {
  console.log(`tro.gg server listening on :${port}`);
});
