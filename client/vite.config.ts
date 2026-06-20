import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

// In dev, Vite has no directory-index resolution, so `/play` would fall through
// to the SPA fallback and serve the landing. Rewrite it to `/play/` so the dev
// server serves the game page — matching how Cloudflare serves `/play` in prod.
const playRoute: Plugin = {
  name: "play-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/play") req.url = "/play/";
      next();
    });
  },
};

export default defineConfig({
  plugins: [playRoute],
  server: { port: 5173 },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        // Two pages: the landing at `/`, the game at `/play`.
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        play: fileURLToPath(new URL("./play/index.html", import.meta.url)),
      },
    },
  },
});
