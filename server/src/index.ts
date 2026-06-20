import "dotenv/config";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ZoneRoom } from "./rooms/ZoneRoom.js";

const port = Number(process.env.PORT ?? 2567);

// The transport owns the Express app that serves the matchmaking routes; we add
// ours through this callback. The client runs on a different origin (Cloudflare
// Pages) and sends credentialed matchmaking requests, so CORS must reflect the
// origin and allow credentials. Lock CLIENT_ORIGIN down in production.
const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? true, credentials: true }));
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });
  },
});

gameServer.define("zone", ZoneRoom);

gameServer.listen(port).then(
  () => console.log(`tro.gg server listening on :${port}`),
  (err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  },
);

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
