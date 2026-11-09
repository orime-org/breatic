# The web-animation container (inner#1711 design §6): the DeepSeek Harness
# writes a HyperFrames composition, our runner packs it with the runtime, the
# frame-ready bridge and the font set, checks it in Chromium and writes it back
# through the Worker. The container has no internet; model calls go through the
# Worker's model.local relay, which adds the key.
#
# Built from the repository root, like the media container: every
# `[[containers]]` block naming this file carries `image_build_context = "../.."`.
# Record the digest of every image deployed (inner#1711 V6).

# ── Build: the runner, the font set, the runtime and dsh ─────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /src

# The runner, bundled into one file with the Worker's shared agreement and the
# three shared modules it reads, resolved through tsconfig's paths.
COPY packages/ingest/tsconfig.json ./
COPY packages/ingest/src ./src
COPY packages/ingest/container ./container
COPY packages/shared/src/timeline/time.ts /shared/src/timeline/time.ts
COPY packages/shared/src/timeline/web-animation-runtime.ts /shared/src/timeline/web-animation-runtime.ts
COPY packages/shared/src/timeline/web-animation-bridge.ts /shared/src/timeline/web-animation-bridge.ts
# Pinned for the same reason as in the media container's Dockerfile.
RUN npm install --no-audit --no-fund --global esbuild@0.25.12 \
  && esbuild container/web-animation-server.ts \
    --bundle --platform=node --format=esm --target=node24 \
    --tsconfig=tsconfig.json \
    --outfile=/out/server.mjs

# The font set, laid out by the same script and from the same pinned package
# versions as the Worker's static assets, so the stylesheet a package embeds
# names exactly the files the preview serves.
COPY packages/ingest/package.json /tmp/ingest-package.json
COPY packages/ingest/scripts/web-animation-fonts.mjs /fonts/packages/ingest/scripts/web-animation-fonts.mjs
COPY config/timeline.yaml /fonts/config/timeline.yaml
RUN set -eu; \
  pinned=$(node -e 'const d = require("/tmp/ingest-package.json").devDependencies; console.log(Object.entries(d).filter(([n]) => n.startsWith("@fontsource-variable/")).map(([n, v]) => `${n}@${v}`).join(" "))'); \
  cd /fonts/packages/ingest; \
  npm install --no-audit --no-fund --ignore-scripts --no-save $pinned; \
  node scripts/web-animation-fonts.mjs /out/fonts

# The HyperFrames runtime at the version every Manifest names
# (WEB_ANIMATION_RUNTIME in shared), with its Apache-2.0 licence.
RUN set -eu; \
  version=$(sed -n 's/.*version: "\([0-9.]*\)".*/\1/p' /shared/src/timeline/web-animation-runtime.ts); \
  mkdir -p /tmp/hyperframes /out/runtime; \
  cd /tmp/hyperframes; \
  npm pack --silent "@hyperframes/core@$version"; \
  tar -xzf "hyperframes-core-$version.tgz" package/dist/hyperframe.runtime.iife.js package/LICENSE; \
  cp package/dist/hyperframe.runtime.iife.js /out/runtime/; \
  cp package/LICENSE /out/runtime/LICENSE

# The DeepSeek Harness at its exact release candidate. Two parts of its closure
# are removed: the LibreOffice kit (MPL-2.0, only the office skill uses it) and
# sharp's native packages under @img (libvips is LGPL-3.0, only image
# attachments use it). dsh boots and runs our profile without either.
RUN set -eu; \
  npm install --prefix /opt/dsh --no-audit --no-fund --ignore-scripts @deepseek-ai/dsh@0.2.2-rc.1; \
  rm -rf /opt/dsh/node_modules/@deepseek-ai/libreoffice-kit* /opt/dsh/node_modules/@img

# ── The image that runs ──────────────────────────────────────────────────
# Node 24 (dsh needs >=24.9 and node:sqlite) and Debian's Chromium, which only
# the check drives. No font package: Chromium sees the font set only through
# the package's own @font-face rules, so a system font fails the check.
FROM node:24-bookworm-slim
ARG RELEASE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.version=$RELEASE_VERSION \
      org.opencontainers.image.revision=$VCS_REF
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/*

# Chromium is a separate program the runner starts; its licence and the
# package's own copyright file stay where Debian puts them, and SOURCE records
# the exact version and where its source is fetched from.
RUN set -eu; \
  version=$(dpkg-query -W -f='${Version}' chromium); \
  mkdir -p /usr/share/chromium-source; \
  { \
    echo "chromium $version, as packaged by Debian bookworm."; \
    echo "Licences: /usr/share/doc/chromium/copyright."; \
    echo "Source: https://snapshot.debian.org/package/chromium/$version/"; \
  } > /usr/share/chromium-source/SOURCE

COPY THIRD-PARTY.md /usr/share/doc/breatic/THIRD-PARTY.md

RUN useradd --create-home --home-dir /home/runner runner
COPY --from=build /opt/dsh /opt/dsh
COPY --from=build /out/fonts /app/fonts
COPY --from=build /out/runtime /app/runtime
COPY --from=build /out/server.mjs /app/server.mjs
COPY --chown=runner:runner packages/ingest/container/web-animation-dsh-profile /home/runner/.dsh/profiles/breatic-web-animation

ENV WEB_ANIMATION_FONTS_DIR=/app/fonts \
    WEB_ANIMATION_RUNTIME_FILE=/app/runtime/hyperframe.runtime.iife.js \
    WEB_ANIMATION_DSH_BIN=/opt/dsh/node_modules/.bin/dsh \
    WEB_ANIMATION_DSH_PROFILE=breatic-web-animation \
    WEB_ANIMATION_CHROMIUM_BIN=/usr/bin/chromium \
    WEB_ANIMATION_HOME=/home/runner
USER runner
EXPOSE 8080
CMD ["node", "/app/server.mjs"]

# Which copy of the repository built this image; see the media container's
# Dockerfile. Last, so every layer above stays shared.
ARG DEV_COPY=
LABEL org.breatic.dev-copy=$DEV_COPY
