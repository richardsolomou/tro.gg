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

Pre-M0 — nothing built yet.
