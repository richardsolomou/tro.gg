import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";

// A unique stamp per build. It is both compiled into the client (as `__BUILD_ID__`)
// and written to `dist/version.json`, so a running client can poll the file and
// notice when a *newer* frontend has shipped. The frontend and backend deploy
// independently — the client to Cloudflare, the SpacetimeDB module to the VPS — so
// a client-only deploy fires no socket disconnect for reconnect.ts to react to;
// polling this stamp is the only signal that new assets are live.
const buildId = `${Date.now()}`;

// Emit dist/version.json alongside the hashed bundle so it ships with this build.
const versionFile: Plugin = {
  name: "version-file",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: buildId }) });
  },
};

// In dev, Vite has no directory-index resolution, so `/play` would fall through
// to the SPA fallback and serve the landing. Rewrite it to `/play/` so the dev
// server serves the game page — matching how Cloudflare serves `/play` in prod.
// `/preview` is the dev-only art preview page (`preview/index.html`); same rewrite.
const playRoute: Plugin = {
  name: "play-route",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      // Split off the query so a deep link like `/preview?creature=…` still rewrites to the
      // directory index (an exact match would miss it and fall through to the SPA landing).
      const [path, query] = (req.url ?? "").split("?");
      const suffix = query ? `?${query}` : "";
      if (path === "/play") req.url = `/play/${suffix}`;
      if (path === "/preview") req.url = `/preview/${suffix}`;
      if (path === "/spike3d") req.url = `/spike3d/${suffix}`;
      next();
    });
  },
};

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [playRoute, versionFile],
  resolve: {
    alias: {
      "@trogg/shared": fileURLToPath(new URL("./shared/index.ts", import.meta.url)),
    },
  },
  server: { port: 5173 },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        // Pages: the landing at `/`, the game at `/play`, the dev art preview at `/preview`,
        // and the full-3D exploration at `/spike3d`.
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        play: fileURLToPath(new URL("./play/index.html", import.meta.url)),
        preview: fileURLToPath(new URL("./preview/index.html", import.meta.url)),
        spike3d: fileURLToPath(new URL("./spike3d/index.html", import.meta.url)),
      },
    },
  },
});
