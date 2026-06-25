# tro.gg tasks — run `just` to list recipes.

spacetime := env_var_or_default("SPACETIME", "spacetime")

# List available recipes.
default:
    @just --list

# Install the SpacetimeDB CLI into the current user profile.
spacetime-install:
    curl -sSf https://install.spacetimedb.com | sh

# Run the local SpacetimeDB instance in the foreground.
start:
    {{spacetime}} start

# Publish the module to the local instance and regenerate client bindings.
publish:
    {{spacetime}} publish --module-path spacetimedb trogg -y
    just generate

# Delete the local development database so branch/schema switches start cleanly.
reset-local-db:
    @dbs="$({{spacetime}} list --server local -y)" || exit $$?; \
    if printf '%s\n' "$$dbs" | awk 'NR > 2 {print $$1}' | grep -qx trogg; then \
        {{spacetime}} delete --server local trogg -y; \
    else \
        echo "No local trogg database to clear."; \
    fi

# Regenerate the TypeScript client bindings from the module schema.
generate:
    {{spacetime}} generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb -y

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

# Regenerate the trogg + Hog avatar sprite sheet (assets/sprites/) from shared/sprites.ts.
sprites:
    pnpm sprites
