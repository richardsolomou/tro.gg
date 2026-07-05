# tro.gg

A tiny multiplayer world in your browser, built incrementally in public as a challenge: **how much of a real multiplayer game can [PostHog](https://posthog.com)'s products power?** The plan is for everything that can be PostHog to be PostHog — analytics, feature flags, error tracking, and more — each doing a real job in the game. The one thing PostHog doesn't offer is a backend — so that's the one piece we run ourselves: a [SpacetimeDB](https://spacetimedb.com) instance self-hosted on a Hetzner VPS, its TypeScript tables, reducers, and procedure wrappers the whole server (no separate database or cache).

You're a trogg in a shared world. Gather to feed the tribe's one fire, hold the light against the dark pressing in past it, and push the frontline outward — but only as far as the tribe is actually there to push it: log off and your trogg keeps working on instinct, at a duller pace, for as long as the fire it helped light lasts.

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

Playable shared-world foundation: SpacetimeDB module + client wired, one zone with presence, grid movement, boulders and trees, account claiming, 3D avatars, recolouring, and zone chat. State lives in durable SpacetimeDB tables, so players and chat resume across reconnects and restarts.

The game design has since pivoted to a fire-and-dark direction (see [docs/gdd.md](docs/gdd.md)): gathered Stone and Wood feed a capped communal stockpile, and the eternal First Fire now holds a visible lit radius at the Hearth. Presence states, dark creatures, and ignition remain the next migration slices. Hog retirement is complete; progress is tracked in the GDD's Roadmap section.

## Development

The repo follows SpacetimeDB's layout:

| Path | What it is | Runs on |
| ---- | ---------- | ------- |
| `src/` | Three.js + Vite game client (`spacetimedb` SDK, `posthog-js`), grouped into `game/` (the 3D world: renderer, creature/item models, rig, HUD icons), `preview/` (the dev model preview page), `ui/` (HTML/CSS HUD), and `net/` (connection + the generated `module_bindings/`, produced from the module schema) | Cloudflare Workers |
| `spacetimedb/` | SpacetimeDB TypeScript module — the tables, reducers, and telemetry procedure wrappers that are the whole backend (matches SpacetimeDB's template layout; intentionally not a pnpm workspace package, so it resolves the SDK from the root `node_modules`) | Self-hosted SpacetimeDB (Hetzner VPS) |
| `shared/` | Pure game logic (motion, constants, avatar colours), imported by both the client and the module | — |

Tasks run through [`just`](https://github.com/casey/just) — run `just` to list recipes. Use `pnpm` for dependency installation and the package scripts consumed by CI/hosting; use `just` for local project tasks. You'll need the [`spacetime` CLI](https://spacetimedb.com/install) installed (it replaces the old Docker requirement).

```sh
pnpm install
just spacetime-install # only if spacetime is not already installed
cp .env.example .env   # VITE_SPACETIMEDB_HOST / _DB_NAME, PostHog key — defaults are local
just start             # local SpacetimeDB instance — leave running in its own terminal
just dev               # clear local trogg data, publish + generate bindings, then client on :5173
```

Fresh cloud task environments often do not have `spacetime` on `PATH`. Use `just spacetime-install`, then either add `/root/.local/bin` to `PATH` or pass the binary explicitly:

```sh
SPACETIME=/root/.local/bin/spacetime just generate
```

Generating bindings does not require SpacetimeDB login; it only needs `node_modules` and the CLI. In this pnpm layout, the Spacetime CLI may warn that `tsc` is not in `spacetimedb/node_modules`; the generate step is still healthy if it finishes successfully. Publishing to a local or hosted database does require the normal `spacetime login`/token setup for the target server.

Dev mirrors prod's module while keeping local data disposable: `just start` runs a local SpacetimeDB instance, and `just dev` deletes the local `trogg` database, publishes the current `spacetimedb/` module, regenerates client bindings, then starts Vite. This keeps branch and migration switches clean. Use `just publish` when you intentionally want to preserve local state while republishing, or `just reset-local-db` to clear only the local database without starting the client. No Docker, no database to provision. The `.env.example` defaults point at the local instance and the `trogg` module, so a fresh `cp` works as-is.

Identity is issued by SpacetimeDB: each browser gets an anonymous Identity and stores its connection token, so a returning visitor resumes the same trogg. Optionally, players can **sign in** to claim an account and log back in on any device — via [SpacetimeAuth](https://spacetimedb.com/docs/core-concepts/authentication/spacetimeauth/) (OIDC, with Discord), run as a browser Authorization-Code-**+-PKCE** flow, so there's still **no auth secret in the repo or bundle**. Accounts are disabled (guest-only) when `VITE_SPACETIMEAUTH_CLIENT_ID` is unset, so a local loop needs no auth setup. The account UI also reads the optional `auth-enabled` flag.

`just build` builds the client; `just typecheck` checks the client and module; `just test` runs the unit tests — shared pure logic (`shared/`), the client prediction controller (`src/movement.test.ts`), and the server reducers (`test/`, which call the real reducers against an in-memory `ctx` since the module can't load under node).

`bin/loadtest` swarms the running instance with bot troggs — real SDK connections with the game client's subscription set, wandering and chatting — and reports connect health, move-ack and chat-delivery latency, fan-out throughput, and server CPU/RSS. `bin/loadtest --bots 1100 --scatter` teleports the swarm to random dry tiles first (owner SQL DML; needs the CLI logged in). Two caveats from its first outing: raise the server terminal's fd limit (`ulimit -n 65536` before `just start`) or macOS's default 256 caps you at ~240 connections, and above a few hundred full-subscription clients the whole-zone fan-out is quadratic — expect the swarm, not the server, to fall over first on one machine.

### Deploy

- **Client → Cloudflare Workers (static assets).** A Worker configured by [`wrangler.jsonc`](wrangler.jsonc) serving `dist` ([`worker.ts`](worker.ts) redirects `www.tro.gg` → `tro.gg` so the game loads from a single origin, then serves the static build). The build emits the landing at `/`, the game at `/play`, and the dev art preview at `/preview`. **Cloudflare Workers Builds watches the connected repo and builds + deploys on push to `main`** (build command `pnpm build`); `npx wrangler deploy` is the manual fallback. Add both `tro.gg` and `www.tro.gg` as custom domains on the Worker. Set `VITE_SPACETIMEDB_HOST` (`wss://spacetime.tro.gg`), `VITE_SPACETIMEDB_DB_NAME` (`trogg`), `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`, and `VITE_SPACETIMEAUTH_CLIENT_ID` (your SpacetimeAuth client; a public/PKCE client, so no secret) as **build** environment variables in the Cloudflare dashboard (baked into the bundle at build time, not read at runtime), along with `NODE_VERSION=24`. The SpacetimeAuth client's allowed redirect URIs must include `https://tro.gg/play` (and `http://localhost:5173/play` for dev); Discord's own credentials live in the SpacetimeAuth dashboard, never here. The generated `src/net/module_bindings/` is committed, so the build needs no SpacetimeDB connection.
- **Backend → self-hosted SpacetimeDB (`spacetime.tro.gg`).** A `spacetimedb` standalone instance runs on the Hetzner VPS behind TLS at `spacetime.tro.gg`. The [`deploy-module`](.github/workflows/deploy-module.yml) GitHub workflow publishes the module on push to `main` (it auto-migrates compatible schema changes in place without disconnecting clients, and fails rather than forcing a destructive change). It needs the `SPACETIME_TOKEN` repository secret — a token for the identity that owns the `trogg` database, from `spacetime login show --token`. One-time, the server is registered with `spacetime server add trogg-prod --url https://spacetime.tro.gg`; `just publish-prod` is the manual path. **Go-live reset:** `just reset-prod-db` (`bin/reset-prod-db`) republishes with `--delete-data`, destroying all production data and re-seeding fresh — run by hand at a launch that changes everything for everyone. It prompts for the database name to confirm; there is no undo. The module is the authoritative backend. Gameplay actions that produce product analytics go through client-callable procedure wrappers; each wrapper mutates inside a SpacetimeDB transaction and then best-effort posts the accepted event to PostHog using the public project key already baked into the client.
- **Preview deployments → per-PR isolated backend.** Each PR gets its own database (`trogg-<branch-slug>`) on the prod instance, isolated from the live `trogg` data. [`preview-module`](.github/workflows/preview-module.yml) publishes it on PR open/sync and may clear only that preview database on incompatible schema changes (`--delete-data=on-conflict`); [`preview-cleanup`](.github/workflows/preview-cleanup.yml) deletes it on close; [`preview-prune`](.github/workflows/preview-prune.yml) sweeps orphans weekly. The frontend half is **Cloudflare Workers Builds**: enable **Settings → Build → Branch control → "Builds for non-production branches"**, which builds every branch and deploys non-production ones via `npx wrangler versions upload` (a per-branch preview URL on `*.workers.dev`). Workers Builds shares one build command and one set of build vars across production and previews — only the deploy command differs — so the build command itself branches on `WORKERS_CI_BRANCH`: `if [ "$WORKERS_CI_BRANCH" != "main" ]; then slug=$(printf '%s' "$WORKERS_CI_BRANCH" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g' | cut -c1-40 | sed -E 's/^-+|-+$//g'); export VITE_SPACETIMEDB_DB_NAME="trogg-$slug"; unset VITE_SPACETIMEAUTH_CLIENT_ID VITE_POSTHOG_KEY; fi; pnpm build`. On `main` the existing prod build vars apply unchanged; on any other branch the client points at `trogg-<slug>` and runs guest-only with no analytics (a `workers.dev` origin is not a registered OIDC redirect anyway). That backend exists only after a PR opens; branch-only frontend previews before a PR are not considered ready to test. `VITE_SPACETIMEDB_HOST` stays `wss://spacetime.tro.gg` for both. The slug derivation must stay identical across the three workflows and this build command.

Because PR previews are the primary review environment, completed work should be committed and pushed immediately, then opened as a PR when it is ready for preview testing. A local-only change is not considered ready for review: the PR workflows publish the isolated backend, and Cloudflare builds the matching frontend preview for the branch.
