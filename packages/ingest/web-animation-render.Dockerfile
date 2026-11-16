# The web-animation render container (#1490 design §6): an export renders a
# source package to video with the HyperFrames producer, checks the frame count
# and size with ffprobe, cuts the first frame as the cover with FFmpeg and writes
# both back through the Worker. The container has no internet.
#
# Built from the repository root, like the creation container: every
# `[[containers]]` block naming this file carries `image_build_context = "../.."`.
# Record the digest of every image deployed.

# ── Build: the runner, the font set ──────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY scripts/release.mjs /src/scripts/release.mjs
ARG RELEASE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
RUN mkdir -p /out && node scripts/release.mjs build-info "$RELEASE_VERSION" "$VCS_REF" /out/build-info.json

COPY packages/ingest/tsconfig.json ./
COPY packages/ingest/src ./src
COPY packages/ingest/container ./container
RUN npm install --no-audit --no-fund --global esbuild@0.25.12 \
  && esbuild container/web-animation-render-server.ts \
    --bundle --platform=node --format=esm --target=node24 \
    --tsconfig=tsconfig.json \
    --external:@hyperframes/producer \
    --outfile=/out/server.mjs

# The same font sets, every released version, from the same script and pinned
# packages as the creation container and the Worker's static assets.
COPY packages/ingest/package.json /tmp/ingest-package.json
COPY packages/ingest/scripts/web-animation-fonts.mjs /fonts/packages/ingest/scripts/web-animation-fonts.mjs
COPY config/timeline.yaml /fonts/config/timeline.yaml
RUN set -eu; \
  pinned=$(node -e 'const d = require("/tmp/ingest-package.json").devDependencies; console.log(Object.entries(d).filter(([n]) => n.startsWith("@fontsource-variable/")).map(([n, v]) => `${n}@${v}`).join(" "))'); \
  cd /fonts/packages/ingest; \
  npm install --no-audit --no-fund --ignore-scripts --no-save $pinned; \
  node scripts/web-animation-fonts.mjs /out/fonts

# The producer at the version every Manifest's runtime names, asserted equal. sharp and its native packages under
# @img (libvips is LGPL-3.0) come in only through @hyperframes/studio-server's thumbnails, which a render never
# loads, and are removed.
COPY packages/shared/src/timeline/web-animation-runtime.ts /shared/src/timeline/web-animation-runtime.ts
RUN set -eu; \
  version=$(sed -n 's/.*version: "\([0-9.]*\)".*/\1/p' /shared/src/timeline/web-animation-runtime.ts); \
  test "$version" = "0.8.186"; \
  mkdir -p /out/app && cd /out/app && npm init -y >/dev/null \
  && npm install --no-audit --no-fund "@hyperframes/producer@$version" \
  && rm -rf /out/app/node_modules/sharp /out/app/node_modules/@img

# chrome-headless-shell at a pinned version, fetched by @puppeteer/browsers, which unpacks it with unzip. It is
# installed at the path the running image keeps it under, so the executable path it records holds there too.
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends unzip; \
  rm -rf /var/lib/apt/lists/*; \
  mkdir -p /opt/chs; \
  npx -y @puppeteer/browsers@3.2.2 install chrome-headless-shell@157.0.8103.78 --path /opt/chs > /tmp/chs-install.log; \
  tail -1 /tmp/chs-install.log | awk '{print $NF}' > /opt/chs/path.txt; \
  test -x "$(cat /opt/chs/path.txt)"

# ── The image that runs ──────────────────────────────────────────────────
FROM node:24-bookworm-slim
ARG RELEASE_VERSION=0.0.0-dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.version=$RELEASE_VERSION \
      org.opencontainers.image.revision=$VCS_REF
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libxshmfence1 \
  && rm -rf /var/lib/apt/lists/*

# FFmpeg and chrome-headless-shell are separate programs the runner starts; their
# versions and where their source is fetched from are recorded in SOURCE.
RUN set -eu; \
  version=$(dpkg-query -W -f='${Version}' ffmpeg); \
  mkdir -p /usr/share/ffmpeg-source; \
  { \
    echo "ffmpeg $version, as packaged by Debian bookworm."; \
    echo "Licences: /usr/share/doc/ffmpeg/copyright."; \
    echo "Source: https://snapshot.debian.org/package/ffmpeg/$version/"; \
  } > /usr/share/ffmpeg-source/SOURCE

COPY THIRD-PARTY.md /usr/share/doc/breatic/THIRD-PARTY.md

RUN useradd --create-home --home-dir /home/runner runner
COPY --from=build /out/app /app
COPY --from=build /opt/chs /opt/chs
COPY --from=build /out/fonts /app/fonts
COPY --from=build /out/server.mjs /app/server.mjs
COPY --from=build /out/build-info.json /app/build-info.json
RUN { echo "chrome-headless-shell 157.0.8103.78, fetched by @puppeteer/browsers 3.2.2."; \
      echo "Source: https://chromium.googlesource.com/chromium/src/+/refs/tags/157.0.8103.78"; } > /opt/chs/SOURCE

ENV WEB_ANIMATION_FONTS_DIR=/app/fonts \
    WEB_ANIMATION_FFMPEG_BIN=/usr/bin/ffmpeg \
    WEB_ANIMATION_FFPROBE_BIN=/usr/bin/ffprobe
USER runner
WORKDIR /app
EXPOSE 8080
CMD ["sh", "-c", "PRODUCER_HEADLESS_SHELL_PATH=$(cat /opt/chs/path.txt) exec node /app/server.mjs"]

ARG DEV_COPY=
LABEL org.breatic.dev-copy=$DEV_COPY
