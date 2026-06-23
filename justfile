# tro.gg tasks — run `just` to list recipes.

# List available recipes.
default:
    @just --list

# Run the local SpacetimeDB instance (foreground, long-lived). Run once in its own
# terminal; `just dev` publishes the module to it. Replaces the old docker compose.
start:
    spacetime start

# Publish the module to the local instance and regenerate client bindings.
publish:
    spacetime publish --module-path spacetimedb trogg -y
    just generate

# Regenerate the TypeScript client bindings from the module schema.
generate:
    spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb -y

# Publish the module, regenerate bindings, then run the client on :5173.
# Assumes `just start` is already running in another terminal.
dev: publish
    pnpm dev

# Deploy the module to the hosted production instance (spacetime.tro.gg).
# One-time setup: spacetime server add trogg-prod --url https://spacetime.tro.gg
publish-prod:
    spacetime publish --server trogg-prod --module-path spacetimedb trogg

# Build the client.
build:
    pnpm build

# Type-check the client and the module.
typecheck:
    pnpm typecheck
    pnpm typecheck:module

# Run the shared pure-logic unit tests.
test:
    pnpm test

# Regenerate the trogg + Hog sprite sheets into public/sprites/.
sprites:
    pnpm sprites
