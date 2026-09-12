# The media container: ffprobe reads what an uploaded object is, ffmpeg lifts a
# cover frame out of it (#209 + #210, design §4.2).
#
# Built from this package's root so the service can import the Worker's own
# modules: the ffprobe arguments and the answer format are one agreement
# between the two sides, and a second copy inside the container would drift.

# ── Bundle the service into one file ─────────────────────────────────────
# The official Node image for this stage only: it carries npm, and nothing
# from it reaches the image that runs.
FROM node:22-alpine AS build
WORKDIR /src
COPY tsconfig.json ./
COPY src ./src
COPY container ./container
# The repo's own esbuild version. Bundling here rather than on whoever runs
# the build is what makes `docker build` the whole of it — which is also the
# fourth GPL obligation below.
RUN npm install --no-audit --no-fund --global esbuild@0.25.12 \
  && esbuild container/server.ts \
    --bundle --platform=node --format=esm --target=node22 \
    --tsconfig=tsconfig.json \
    --outfile=/out/server.mjs

# ── The image that runs ──────────────────────────────────────────────────
# Alpine rather than a Node base image: the service is that one bundled file,
# so npm and the rest of a Node distribution would be weight with no reader,
# and image size is what the cold start is paid in.
FROM alpine:3.22
RUN apk add --no-cache nodejs=~22 ffmpeg=~6.1

# ── ffmpeg is GPL-licensed (#178) ────────────────────────────────────────
# Alpine builds ffmpeg with GPL components (x264 among them), so distributing
# this image distributes GPL software. Three obligations are met here and the
# fourth by the build being this file:
#
#   1. The licence texts travel with the image, in the directory below. Both:
#      the package declares GPL-2.0-or-later AND LGPL-2.1-or-later.
#   2. The version and its origin are recorded beside them.
#   3. That record names where the corresponding source is fetched from.
#   4. This Dockerfile is the whole build; anyone can reproduce it.
#
# The texts are copied from this repository rather than pulled at build time.
# Alpine's ffmpeg package installs no licence file of its own — measured, the
# image has none anywhere — so a build that expected to find one would meet
# none of the four while reading as though it met three.
COPY container/COPYING.GPLv2 /usr/share/ffmpeg-source/COPYING.GPLv2
COPY container/COPYING.LGPLv2.1 /usr/share/ffmpeg-source/COPYING.LGPLv2.1

# Every value is read out of the package database rather than written here, so
# what the notice claims is what was actually installed. `c:` is the aports
# commit the package was built from, which names the recipe exactly — a branch
# moves on and stops describing this build.
RUN set -eu; \
  info=$(awk '/^P:ffmpeg$/,/^$/' /lib/apk/db/installed); \
  version=$(printf '%s\n' "$info" | sed -n 's/^V://p'); \
  licence=$(printf '%s\n' "$info" | sed -n 's/^L://p'); \
  commit=$(printf '%s\n' "$info" | sed -n 's/^c://p'); \
  upstream=$(printf '%s\n' "$version" | sed 's/-r[0-9]*$//'); \
  { \
    echo "ffmpeg $version, licensed $licence."; \
    echo; \
    echo "Built by Alpine Linux from the recipe at this exact commit:"; \
    echo "  https://gitlab.alpinelinux.org/alpine/aports/-/tree/$commit/community/ffmpeg"; \
    echo; \
    echo "The program's own source for this version:"; \
    echo "  https://ffmpeg.org/releases/ffmpeg-$upstream.tar.xz"; \
    echo; \
    echo "The licence texts are in this directory."; \
  } > /usr/share/ffmpeg-source/SOURCE

COPY --from=build /out/server.mjs /app/server.mjs

# Listening starts immediately: nothing is prepared at startup, because every
# second before the port answers is a second the request that woke this
# container spends waiting.
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
