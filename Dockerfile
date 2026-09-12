# ── Stage 1: Install dependencies + Build ────────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Fetch every package named in the lockfile into the local store. This layer
# is keyed on the lockfile alone, so editing source never re-downloads.
#
# Nothing in this stage enumerates the packages in the workspace, and that is
# the point. The previous version listed each one's package.json by hand, so
# adding a member to pnpm-workspace.yaml left this file describing a workspace
# that no longer existed — the install tolerated it and `pnpm deploy` did not,
# which is a build failure several minutes into CI for a line nobody knew was
# a second copy of the workspace definition.
COPY pnpm-lock.yaml .npmrc ./
# `pnpm fetch` reads `pnpm.patchedDependencies` and hashes the file it names,
# so the patch has to be here before it runs, not with the source below.
COPY patches/ patches/
RUN pnpm fetch

# The whole workspace, so nothing here can fall out of step with it.
COPY . .

# Install all dependencies (including devDependencies for build) from the
# store fetched above, so this re-runs on a source change but downloads
# nothing.
RUN pnpm install --offline --frozen-lockfile --ignore-scripts=false

# Build backend packages (shared → core → server + collab + worker)
RUN pnpm turbo build --filter=@breatic/server --filter=@breatic/collab --filter=@breatic/worker

# Deploy production-only deps for server, worker, and collab
RUN pnpm deploy --filter=@breatic/server --prod /app/deploy/server
RUN pnpm deploy --filter=@breatic/worker --prod /app/deploy/worker
RUN pnpm deploy --filter=@breatic/collab --prod /app/deploy/collab

# ── Stage 2: Runtime (slim) ──────────────────────────────────────────
FROM node:22-slim AS runtime

# ffmpeg for the worker's eight video mini-tools (crop, cut, speed, adjust,
# stabilisation, scene extension, audio denoise, HDR conversion). Cover frames
# and media metadata are the media container's job (packages/ingest), and #225
# moves these eight there too.
#
# The version is pinned because THIRD-PARTY.md names it, and GPL-2 §3 asks for
# the source of the binary actually distributed. Unpinned, a rebuild after
# bookworm moves on would ship one version while the notice points at another.
# When this fails because the pin is gone from the archive, update both: this
# line and the "FFmpeg in the `breatic` image" entry in THIRD-PARTY.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg=7:5.1.9-0+deb12u1 \
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

# Domain: built output (server+worker shared AIGC business; consumed via node_modules)
COPY --from=builder /app/packages/domain/dist ./packages/domain/dist
COPY --from=builder /app/packages/domain/package.json ./packages/domain/

# Shared: built output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/

# Runtime config, skills, locales
COPY config/ ./config/
COPY skills/ ./skills/
COPY locales/ ./locales/
COPY package.json pnpm-workspace.yaml ./

# Drizzle migration SQL files (for auto-migrate at startup)
COPY --from=builder /app/packages/core/src/db/migrations ./packages/core/src/db/migrations

ENV NODE_ENV=production

EXPOSE 3000 1234

# Default: API server. Override with docker-compose `command`.
CMD ["node", "packages/server/dist/index.js"]
