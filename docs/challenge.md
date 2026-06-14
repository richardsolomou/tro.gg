# The challenge

Build a multiplayer browser game using nothing but tools under the PostHog umbrella, reaching outside only for what PostHog doesn't offer. The backend exception is Convex, which also dogfoods the PostHog×Convex integration in public. The game is built incrementally, in public, using PostHog Code.

- **Premise:** how much of a real multiplayer game can PostHog's products power — flags, experiments, replays, error tracking, surveys, AI observability — all doing real jobs, in the open. The per-product plan is in [analytics.md](analytics.md).
- **Non-goals:** a full MMO, combat (deferred indefinitely), polished art, a roadmap that outlives the fun. Every milestone is a valid stopping point; stopping is a concluded experiment, not an abandoned game.
- **Design target:** 10–100 concurrent players. The first M in MMO is a lie and that's fine.

## The game, in brief

RuneScape-meets-Valheim, radically reduced: a persistent pixel-art world, click-to-move and WASD, gathering and crafting skills, communal construction, hedgehog NPCs to befriend and protect. Event-based, not twitchy — the gameplay is inventories, timers, and numbers going up, which is exactly the shape Convex and PostHog are good at. The binding spec is [gdd.md](gdd.md); setting and tone are in [world.md](world.md).
