# The page reader (inner#1664): a Chromium headless shell that reads the pages
# of one web_fetch call. Every request it makes leaves through the ingest
# Worker's outbound handler (src/web-reader-outbound.ts).
#
# Built from the repository root, like the media container: wrangler resolves
# the build context against wrangler.toml's directory, so each container block
# for this image carries `image_build_context = "../.."`.

# ── Bundle the service into one file ─────────────────────────────────────
# Our code, the shared protocol it reads (resolved through tsconfig's
# @shared/* path) and zod go into the bundle. The four libraries the service
# runs are installed in the image that runs, at the versions
# packages/ingest/package.json pins: Playwright brings its browser files, and
# Readability is read as a file and run inside each page.
FROM node:24-bookworm-slim AS build
WORKDIR /src/packages/ingest
COPY tsconfig.base.json /src/tsconfig.base.json
COPY packages/ingest/web-reader ./web-reader
COPY packages/shared/src /src/packages/shared/src
COPY scripts/release.mjs /src/scripts/release.mjs
ARG RELEASE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
RUN mkdir -p /out && node /src/scripts/release.mjs build-info "$RELEASE_VERSION" "$VCS_REF" /out/build-info.json
# Pinned so the image builds the same way on every machine, as the media
# container's esbuild is; zod at the version the workspace catalog resolves.
RUN npm install --prefix /src/packages/shared --no-audit --no-fund --no-save zod@4.4.3 \
  && npm install --no-audit --no-fund --global esbuild@0.25.12 \
  && esbuild web-reader/src/server.ts \
    --bundle --platform=node --format=esm --target=node24 \
    --tsconfig=web-reader/tsconfig.json \
    --external:playwright-core --external:@mozilla/readability --external:turndown --external:unpdf \
    --outfile=/out/server.mjs

# ── The image that runs ──────────────────────────────────────────────────
FROM node:24-bookworm-slim
ARG RELEASE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.version=$RELEASE_VERSION \
      org.opencontainers.image.revision=$VCS_REF
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The headless shell only: the full browser opens a PDF in its own viewer and
# reads nothing, where the shell hands a PDF over as a download.
RUN npm install --no-audit --no-fund --omit=dev \
    playwright-core@1.62.1 @mozilla/readability@0.6.0 turndown@7.2.0 unpdf@1.1.0 \
  && npx playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# What this image distributes and under what terms.
COPY THIRD-PARTY.md /usr/share/doc/breatic/THIRD-PARTY.md
COPY --from=build /out/server.mjs /app/server.mjs
COPY --from=build /out/build-info.json /app/build-info.json

EXPOSE 8080
CMD ["node", "/app/server.mjs"]

# Which copy of the repository built this image, set by `image_vars` in a
# local wrangler.toml and empty for a deploy (see packages/ingest/Dockerfile).
ARG DEV_COPY=
LABEL org.breatic.dev-copy=$DEV_COPY
