# tro.gg tasks — run `just` to list recipes.

# List available recipes.
default:
    @just --list

# Start Postgres + Valkey, run the dev stack, and stop the containers on exit.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    docker compose up -d --wait
    trap 'docker compose stop' EXIT
    pnpm dev

# Start the backing services (Postgres + Valkey) in the background.
db-up:
    docker compose up -d --wait

# Stop the backing services, keeping their data in the volumes.
db-down:
    docker compose down

# Build all packages.
build:
    pnpm build

# Type-check all packages.
typecheck:
    pnpm typecheck

# Run the server unit tests.
test:
    pnpm --filter @trogg/server test
