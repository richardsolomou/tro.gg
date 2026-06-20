# tro.gg

A tiny multiplayer world in your browser, built incrementally in public as a challenge: **how much of a real multiplayer game can [PostHog](https://posthog.com)'s products power?** The plan is for everything that can be PostHog to be PostHog — analytics, feature flags, error tracking, AI observability, and more — each doing a real job in the game. The one thing PostHog doesn't offer is a backend — so that's the one piece we run ourselves: a [Colyseus](https://colyseus.io) game server self-hosted on a Hetzner VPS, with Postgres and Redis behind it.

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

M0 in progress — Colyseus client/server wired, one zone room with presence, WASD movement, and zone chat (speech bubbles + history panel), persisted to Postgres with a Redis cache (players and chat resume across reconnects and restarts).

## Development

A pnpm workspace with three packages:

| Package | What it is | Runs on |
| ------- | ---------- | ------- |
| `client` | PixiJS + Vite game client (`@colyseus/sdk`, `posthog-js`) | Cloudflare Pages |
| `server` | Colyseus game server — one room per zone | Self-hosted (Hetzner VPS) |
| `shared` | Room-state schema, message types, and GDD constants, imported by both | — |

```sh
pnpm install
cp client/.env.example client/.env   # set VITE_COLYSEUS_URL, PostHog key
cp server/.env.example server/.env   # set DATABASE_URL, REDIS_URL, AUTH_SECRET
docker compose up -d                 # local Postgres + Redis (mirrors prod)
pnpm dev                             # client on :5173, server on :2567
```

Persistence is optional in dev: with no `DATABASE_URL` / `REDIS_URL` the server runs in-memory only, so `docker compose` is skippable for a quick UI loop. `AUTH_SECRET` signs guest credentials; unset, the server uses an ephemeral key, so tokens (and the troggs behind them) don't survive a restart.

`pnpm build` builds all three; `pnpm typecheck` checks them; `pnpm --filter @trogg/server test` runs the server unit tests.

### Deploy

- **Client → Cloudflare Pages.** Build command `pnpm build:client`, output directory `client/dist`. Set `VITE_COLYSEUS_URL` (the server's `wss://` URL) and the PostHog vars as Pages environment variables.
- **Server → Dokploy (VPS).** Built from [`server/Dockerfile`](server/Dockerfile) (multi-stage; build context is the repo root so `shared/` is in scope). In Dokploy: create an Application from this repo with build type Dockerfile, provision Postgres and Redis as services, and add a domain on container port `2567` with HTTPS — Traefik proxies the WebSocket transport without extra config. Set `PORT`, `CLIENT_ORIGIN` (the Pages origin), `DATABASE_URL` (Postgres), `REDIS_URL` (cache + Colyseus presence/driver), and `AUTH_SECRET` (a stable random string signing guest credentials) as environment variables, using the stores' internal connection URLs.
