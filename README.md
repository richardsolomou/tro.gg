# tro.gg

A tiny multiplayer world in your browser, built incrementally in public as a challenge: **how much of a real multiplayer game can [PostHog](https://posthog.com)'s products power?** The plan is for everything that can be PostHog to be PostHog — analytics, feature flags, error tracking, AI observability, and more — each doing a real job in the game. The one thing PostHog doesn't offer is a backend — so that's the one piece we run ourselves: a [Colyseus](https://colyseus.io) game server self-hosted on a Hetzner VPS, with Postgres and Valkey behind it.

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

M0 in progress — Colyseus client/server wired, one zone room with presence, WASD movement, and zone chat (speech bubbles + history panel), persisted to Postgres with a Valkey cache (players and chat resume across reconnects and restarts).

## Development

A pnpm workspace with three packages:

| Package | What it is | Runs on |
| ------- | ---------- | ------- |
| `client` | PixiJS + Vite game client (`@colyseus/sdk`, `posthog-js`) | Cloudflare Pages |
| `server` | Colyseus game server — one room per zone | Self-hosted (Hetzner VPS) |
| `shared` | Room-state schema, message types, and GDD constants, imported by both | — |

Tasks run through [`just`](https://github.com/casey/just) — run `just` to list recipes.

```sh
pnpm install
cp client/.env.example client/.env   # VITE_COLYSEUS_URL, PostHog key
cp server/.env.example server/.env   # DATABASE_URL, REDIS_URL, AUTH_SECRET — defaults match docker compose
just dev                             # Postgres + Valkey, then client on :5173, server on :2567
```

Dev mirrors prod: `just dev` brings up local Postgres + Valkey (via `docker compose`) so the server always persists the same way it does in production — players and chat resume across reloads — and stops the containers again when you exit dev (their data stays in the volumes). The `.env.example` defaults point at those containers, so a fresh `cp` works as-is. (`just db-up` / `just db-down` manage the containers independently; Docker must be running.) Valkey speaks the Redis protocol, so the connection is still `REDIS_URL` / a `redis://` URL.

`AUTH_SECRET` signs guest credentials; unset, the server uses an ephemeral key, so tokens (and the troggs behind them) don't survive a restart — the example sets a stable dev value.

`just build` builds all three; `just typecheck` checks them; `just test` runs the server unit tests.

### Deploy

- **Client → Cloudflare Pages.** Build command `pnpm build:client`, output directory `client/dist`. Set `VITE_COLYSEUS_URL` (the server's `wss://` URL) and the PostHog vars as Pages environment variables.
- **Server → Dokploy (VPS).** Built from [`server/Dockerfile`](server/Dockerfile) (multi-stage; build context is the repo root so `shared/` is in scope). In Dokploy: create an Application from this repo with build type Dockerfile, provision Postgres and Valkey as services, and add a domain on container port `2567` with HTTPS — Traefik proxies the WebSocket transport without extra config. Set `PORT`, `CLIENT_ORIGIN` (the Pages origin), `DATABASE_URL` (Postgres), `REDIS_URL` (cache + Colyseus presence/driver), and `AUTH_SECRET` (a stable random string signing guest credentials) as environment variables, using the stores' internal connection URLs.
