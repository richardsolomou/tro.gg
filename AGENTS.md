# Agent instructions

Read [docs/gdd.md](docs/gdd.md) before changing game rules, data model, shared constants, or user-facing mechanics. It is the source of truth for glossary, durable design decisions, and current system behavior. Its "How to use this document" and "Invariants" sections are binding. [docs/analytics.md](docs/analytics.md) is binding when adding or changing custom events, experiments, or feature flags. [docs/world.md](docs/world.md) is canonical for setting, tone, and naming in UI copy. [docs/challenge.md](docs/challenge.md) is human-facing background; you rarely need it.

Roadmap notes in the docs are planning context, not permission gates. Do not block useful work because older notes placed it later. When you ship or change a mechanic, schema, constant, event, or flag, update the relevant docs in the same change so the spec never drifts from the code. If code starts reading a PostHog feature flag, create or update the real flag in the configured PostHog project during the same task, with the intended rollout; don't leave flag creation as a manual follow-up.

## Delivery workflow

Always commit and push completed work. This project is primarily tested in PR preview environments, not only local dev: each pushed PR branch triggers GitHub workflows and Cloudflare Workers preview builds, including a frontend preview and an isolated SpacetimeDB backend for that PR. Do not leave finished code, docs, generated bindings, schema changes, or migrations only in the local worktree. By the time a maintainer opens GitHub or Cloudflare, the latest task should already be on the remote branch and the preview deployment should already be building.

Before pushing, run the relevant checks for the change. For normal code/schema/client work, prefer `pnpm test`, `pnpm typecheck`, `pnpm typecheck:module`, and `pnpm build` unless the task is docs-only or the user explicitly asks to skip checks. If a check cannot be run, say so in the final response.
