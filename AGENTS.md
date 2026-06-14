# Agent instructions

Read [docs/gdd.md](docs/gdd.md) before making any change — it is the source of truth for game rules, glossary, data model, constants, and scope. Its "How to use this document" and "Invariants" sections are binding, as are the event and flag registries in [docs/analytics.md](docs/analytics.md). [docs/world.md](docs/world.md) is canonical for setting, tone, and naming in UI copy. [docs/challenge.md](docs/challenge.md) is human-facing background; you rarely need it.

Check the milestone tracker in the GDD for the current milestone and don't build ahead of it. When you ship or change a mechanic, update the docs in the same change (GDD tracker and constants, analytics event/flag registries) so the spec never drifts from the code.
