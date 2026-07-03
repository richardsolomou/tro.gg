# tro.gg tasks — run `just` to list recipes.

spacetime := env_var_or_default("SPACETIME", "spacetime")

# Address the local dev SpacetimeDB listens on. 3001 rather than the 3000 default
# so it doesn't collide with Social Stream Ninja's local server on 3000.
local_addr := "127.0.0.1:3001"
local_server := "http://" + local_addr

# List available recipes.
default:
    @just --list

# Install the SpacetimeDB CLI into the current user profile.
spacetime-install:
    curl -sSf https://install.spacetimedb.com | sh

# Run the local SpacetimeDB instance in the foreground.
start:
    {{spacetime}} start --listen-addr {{local_addr}}

# Publish the module to the local instance and regenerate client bindings.
publish:
    {{spacetime}} publish --server {{local_server}} --module-path spacetimedb trogg -y
    just generate

# Delete the local development database so branch/schema switches start cleanly.
# `spacetime list` only reports databases for the current identity, but a `trogg`
# left by another identity still exists and blocks a publish with a migration
# error — so delete by name unconditionally (idempotent with -y) rather than
# gating on a list match that can miss it.
reset-local-db:
    @echo "Clearing local trogg database (if present)…"
    @{{spacetime}} delete --server {{local_server}} trogg -y

# Regenerate the TypeScript client bindings from the module schema.
generate:
    {{spacetime}} generate --lang typescript --out-dir src/net/module_bindings --module-path spacetimedb -y

# Clear the local database, publish the module, regenerate bindings, then run the client on :5173.
dev: reset-local-db publish
    pnpm dev

# Deploy the module to the hosted production instance (spacetime.tro.gg).
publish-prod:
    {{spacetime}} publish --server trogg-prod --module-path spacetimedb trogg

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
