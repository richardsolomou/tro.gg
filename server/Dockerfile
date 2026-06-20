# Builds the Colyseus game server from the pnpm workspace. Run with the build
# context set to the repo root (Dokploy: "Docker file path" = server/Dockerfile,
# leave the build context as the repo root) so shared/ is in scope.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app

# Install against the lockfile with only the manifests copied first, so the
# dependency layer caches across source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile --filter @trogg/shared --filter @trogg/server

COPY shared shared
COPY server server
RUN pnpm --filter @trogg/shared build && pnpm --filter @trogg/server build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The workspace symlinks in node_modules resolve @trogg/shared to its built dist,
# so the whole tree comes across rather than a pruned copy.
COPY --from=build /app /app
WORKDIR /app/server
EXPOSE 2567
CMD ["node", "dist/index.js"]
