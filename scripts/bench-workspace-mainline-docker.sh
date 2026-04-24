#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${OAH_BENCH_DOCKER_IMAGE_TAG:-oah-workspace-mainline-bench:local}"
CONTAINER_CPUS="${OAH_BENCH_DOCKER_CPUS:-2}"
CONTAINER_MEMORY="${OAH_BENCH_DOCKER_MEMORY:-2g}"

export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"

docker build \
  -f - \
  -t "${IMAGE_TAG}" \
  "${ROOT_DIR}" <<'EOF'
FROM node:24-alpine

ENV CARGO_HOME=/root/.cargo
ENV PATH=/root/.cargo/bin:${PATH}

RUN apk add --no-cache curl ca-certificates build-base cmake perl pkgconf \
  && curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/compose-scaler/package.json ./apps/compose-scaler/package.json
COPY apps/controller/package.json ./apps/controller/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/api-contracts/package.json ./packages/api-contracts/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/config-server-control/package.json ./packages/config-server-control/package.json
COPY packages/engine-core/package.json ./packages/engine-core/package.json
COPY packages/model-gateway/package.json ./packages/model-gateway/package.json
COPY packages/native-bridge/package.json ./packages/native-bridge/package.json
COPY packages/scale-target-control/package.json ./packages/scale-target-control/package.json
COPY packages/storage-memory/package.json ./packages/storage-memory/package.json
COPY packages/storage-postgres/package.json ./packages/storage-postgres/package.json
COPY packages/storage-redis/package.json ./packages/storage-redis/package.json
COPY packages/storage-redis-control/package.json ./packages/storage-redis-control/package.json
COPY packages/storage-sqlite/package.json ./packages/storage-sqlite/package.json

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
  pnpm config set store-dir /root/.local/share/pnpm/store \
  && pnpm fetch --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
COPY native ./native
COPY scripts ./scripts

RUN --mount=type=cache,target=/root/.cargo/registry \
  --mount=type=cache,target=/root/.cargo/git \
  --mount=type=cache,target=/root/.local/share/pnpm/store \
  --mount=type=cache,target=/app/.native-target \
  pnpm config set store-dir /root/.local/share/pnpm/store \
  && pnpm install --frozen-lockfile --offline \
  && cargo build --manifest-path ./native/Cargo.toml --target-dir /app/.native-target --release -p oah-workspace-sync

ENV OAH_NATIVE_WORKSPACE_SYNC_BINARY=/app/.native-target/release/oah-workspace-sync

ENTRYPOINT ["pnpm", "exec", "tsx", "scripts/bench-workspace-mainline.ts"]
EOF

docker run --rm \
  --cpus="${CONTAINER_CPUS}" \
  --memory="${CONTAINER_MEMORY}" \
  "${IMAGE_TAG}" \
  "$@"
