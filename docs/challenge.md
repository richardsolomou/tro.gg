# The challenge

Build a multiplayer browser game using nothing but tools under the PostHog umbrella, reaching outside only for what PostHog doesn't offer. The one exception is the backend — a [SpacetimeDB](https://spacetimedb.com) instance we self-host on a Hetzner VPS, its tables, reducers, and procedure wrappers the entire server (no separate database or cache). It's the one piece PostHog doesn't provide, and the one piece we run ourselves. The game is built incrementally, in public, using PostHog Code.

- **Premise:** how much of a real multiplayer game can PostHog's products power — analytics, feature flags, error tracking, AI observability, and more — all doing real jobs, in the open. The per-product plan is in [analytics.md](analytics.md).
- **Non-goals:** a full MMO, combat (deferred indefinitely), polished art, a roadmap that outlives the fun. Every coherent stopping point is valid; stopping is a concluded experiment, not an abandoned game.
- **Design target:** 10–100 concurrent players. The first M in MMO is a lie and that's fine.

## The game, in brief

OldSchool RuneScape meets Valheim, radically reduced: a persistent pixel-art world, click-to-move and WASD, gathering and crafting skills that gate harder content — better tools reach better materials, repeat outward — and hedgehog NPCs to befriend and protect. Event-based, not twitchy — the gameplay is inventories, timers, and numbers going up, which is exactly the shape an event-based server and PostHog are good at. The binding spec is [gdd.md](gdd.md); setting and tone are in [world.md](world.md).
