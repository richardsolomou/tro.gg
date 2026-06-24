# tro.gg

A tiny multiplayer world in your browser, built incrementally in public as a challenge: **how much of a real multiplayer game can [PostHog](https://posthog.com)'s products power?** The plan is for everything that can be PostHog to be PostHog — analytics, feature flags, error tracking, AI observability, and more — each doing a real job in the game. The one thing PostHog doesn't offer is a backend — so that's the one piece we run ourselves: a [SpacetimeDB](https://spacetimedb.com) instance self-hosted on a Hetzner VPS, its TypeScript tables and reducers the whole server (no separate database or cache).

You're a trogg in a shared world. Gather, craft better gear, and push into harder ground — alongside the Hogs, a town of friendly hedgehogs — as the world grows, one piece at a time.

## Play

[tro.gg](https://tro.gg) — you'll exist in the world within seconds, no signup.

## Docs

| Doc | What it is |
| --- | ---------- |
| [docs/challenge.md](docs/challenge.md) | The premise — why this project exists |
| [docs/gdd.md](docs/gdd.md) | Game design document — the binding spec for systems, data, and scope |
| [docs/world.md](docs/world.md) | Setting and tone — what's fixed, what's deferred |
| [docs/analytics.md](docs/analytics.md) | The PostHog plan — events, flags, experiments |

## Status

Playable shared-world foundation: SpacetimeDB module + client wired, one zone with presence, grid movement, boulders, roaming Hogs, account claiming, avatar sprites, recolouring, and zone chat. State lives in durable SpacetimeDB tables, so players and chat resume across reconnects and restarts.

## Development

The repo follows SpacetimeDB's layout:

| Path | What it is | Runs on |
| ---- | ---------- | ------- |
| `src/` | PixiJS + Vite game client (`spacetimedb` SDK, `posthog-js`); `src/module_bindings/` is generated from the module schema | Cloudflare Workers |
| `spacetimedb/` | SpacetimeDB TypeScript module — the tables and reducers that are the whole backend (matches SpacetimeDB's template layout; intentionally not a pnpm workspace package, so it resolves the SDK from the root `node_modules`) | Self-hosted SpacetimeDB (Hetzner VPS) |
| `shared/` | Pure game logic (motion, constants, avatar colours), imported by both the client and the module | — |

Tasks run through [`just`](https://github.com/casey/just) — run `just` to list recipes. You'll need the [`spacetime` CLI](https://spacetimedb.com/install) installed (it replaces the old Docker requirement).

```sh
pnpm install
pnpm spacetime:install # only if spacetime is not already installed
cp .env.example .env   # VITE_SPACETIMEDB_HOST / _DB_NAME, PostHog key — defaults are local
just start             # local SpacetimeDB instance — leave running in its own terminal
just dev               # publish the module + generate bindings, then client on :5173
```

Fresh cloud task environments often do not have `spacetime` on `PATH`. Use `pnpm spacetime:install` or `just spacetime-install`, then either add `/root/.local/bin` to `PATH` or pass the binary explicitly:

```sh
SPACETIME=/root/.local/bin/spacetime pnpm module:generate
SPACETIME=/root/.local/bin/spacetime just generate
```

Generating bindings does not require SpacetimeDB login; it only needs `node_modules` and the CLI. In this pnpm layout, the Spacetime CLI may warn that `tsc` is not in `spacetimedb/node_modules`; the generate step is still healthy if it finishes successfully. Publishing to a local or hosted database does require the normal `spacetime login`/token setup for the target server.

Dev mirrors prod: `just start` runs a local SpacetimeDB instance, and `just dev` publishes the same `spacetimedb/` module that production runs and regenerates the client bindings, so state persists exactly as it does in prod — players and chat resume across reloads and restarts. No Docker, no database to provision. The `.env.example` defaults point at the local instance and the `trogg` module, so a fresh `cp` works as-is.

Identity is issued by SpacetimeDB: each browser gets an anonymous Identity and stores its connection token, so a returning visitor resumes the same trogg. Optionally, players can **sign in** to claim an account and log back in on any device — via [SpacetimeAuth](https://spacetimedb.com/docs/core-concepts/authentication/spacetimeauth/) (OIDC, with Discord), run as a browser Authorization-Code-**+-PKCE** flow, so there's still **no auth secret in the repo or bundle**. Accounts are disabled (guest-only) when `VITE_SPACETIMEAUTH_CLIENT_ID` is unset, so a local loop needs no auth setup. The account UI also reads the optional `auth-enabled` flag.

`just build` builds the client; `just typecheck` checks the client and the module; `just test` runs the shared unit tests.

### Deploy

- **Client → Cloudflare Workers (static assets).** A Worker configured by [`wrangler.jsonc`](wrangler.jsonc) serving `dist` ([`worker.ts`](worker.ts) redirects `www.tro.gg` → `tro.gg` so the game loads from a single origin, then serves the static build). The build emits two pages: the landing at `/` and the game at `/play`. **Cloudflare Workers Builds watches the connected repo and builds + deploys on push to `main`** (build command `pnpm build`); `npx wrangler deploy` is the manual fallback. Add both `tro.gg` and `www.tro.gg` as custom domains on the Worker. Set `VITE_SPACETIMEDB_HOST` (`wss://spacetime.tro.gg`), `VITE_SPACETIMEDB_DB_NAME` (`trogg`), `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`, and `VITE_SPACETIMEAUTH_CLIENT_ID` (your SpacetimeAuth client; a public/PKCE client, so no secret) as **build** environment variables in the Cloudflare dashboard (baked into the bundle at build time, not read at runtime), along with `NODE_VERSION=24`. The SpacetimeAuth client's allowed redirect URIs must include `https://tro.gg/play` (and `http://localhost:5173/play` for dev); Discord's own credentials live in the SpacetimeAuth dashboard, never here. The generated `src/module_bindings/` is committed, so the build needs no SpacetimeDB connection.
- **Backend → self-hosted SpacetimeDB (`spacetime.tro.gg`).** A `spacetimedb` standalone instance runs on the Hetzner VPS behind TLS at `spacetime.tro.gg`. The [`deploy-module`](.github/workflows/deploy-module.yml) GitHub workflow publishes the module on push to `main` (it auto-migrates compatible schema changes in place without disconnecting clients, and fails rather than forcing a destructive change). It needs the `SPACETIME_TOKEN` repository secret — a token for the identity that owns the `trogg` database, from `spacetime login show --token`. One-time, the server is registered with `spacetime server add trogg-prod --url https://spacetime.tro.gg`; `just publish-prod` is the manual path. The module is the entire backend; there's no container image, database, or cache to provision.
