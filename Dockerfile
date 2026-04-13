# ── Stage 1: Install dependencies + Build ────────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace config + package.json files first (layer caching)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/worker/package.json packages/worker/
COPY packages/collab/package.json packages/collab/
COPY packages/web/package.json packages/web/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile --ignore-scripts=false

# Copy source code + config + locales
COPY packages/ packages/
COPY tsconfig.base.json turbo.json ./
COPY locales/ locales/

# Build backend packages (shared → core → server + collab + worker)
RUN pnpm turbo build --filter=@breatic/server --filter=@breatic/collab --filter=@breatic/worker

# Deploy production-only deps for server, worker, and collab
RUN pnpm deploy --filter=@breatic/server --prod /app/deploy/server
RUN pnpm deploy --filter=@breatic/worker --prod /app/deploy/worker
RUN pnpm deploy --filter=@breatic/collab --prod /app/deploy/collab

# ── Stage 2: Runtime (slim) ──────────────────────────────────────────
FROM node:22-slim AS runtime

# ffmpeg for video cover extraction (first frame → JPEG)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Server: built output + production node_modules
COPY --from=builder /app/deploy/server/node_modules ./packages/server/node_modules
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/

# Worker: built output + production node_modules
COPY --from=builder /app/deploy/worker/node_modules ./packages/worker/node_modules
COPY --from=builder /app/packages/worker/dist ./packages/worker/dist
COPY --from=builder /app/packages/worker/package.json ./packages/worker/

# Collab: built output + production node_modules
COPY --from=builder /app/deploy/collab/node_modules ./packages/collab/node_modules
COPY --from=builder /app/packages/collab/dist ./packages/collab/dist
COPY --from=builder /app/packages/collab/package.json ./packages/collab/

# Core: built output (consumed by server/worker/collab via node_modules)
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/

# Shared: built output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# Runtime config, skills, agents, locales
COPY config/ ./config/
COPY skills/ ./skills/
COPY agents/ ./agents/
COPY locales/ ./locales/
COPY package.json pnpm-workspace.yaml ./

# Drizzle migration SQL files (for auto-migrate at startup)
COPY --from=builder /app/packages/core/src/db/migrations ./packages/core/src/db/migrations

ENV NODE_ENV=production

EXPOSE 3000 1234

# Default: API server. Override with docker-compose `command`.
CMD ["node", "packages/server/dist/index.js"]
