# The media container: ffprobe reads what an uploaded object is, ffmpeg lifts a
# cover frame out of it (#209 + #210, design §4.2).
#
# The service imports the Worker's own modules: the ffprobe arguments and the
# answer format are one agreement between the two sides, and a second copy
# inside the container would drift.
#
# Built from the repository root, which is what puts THIRD-PARTY.md within
# reach. wrangler resolves the build context against the directory its config
# sits in and defaults it to the Dockerfile's own directory, so both container
# blocks in wrangler.toml and its template carry
# `image_build_context = "../.."`. Every source below is therefore written from
# the repository root.

# ── Bundle the service into one file ─────────────────────────────────────
# The official Node image for this stage only: it carries npm, and nothing
# from it reaches the image that runs.
FROM node:22-alpine AS build
WORKDIR /src
COPY packages/ingest/tsconfig.json ./
COPY packages/ingest/src ./src
COPY packages/ingest/container ./container
# esbuild is pinned so this image builds the same way on every machine. No
# manifest in this repository declares esbuild — it arrives seven times over as
# a transitive dependency, at seven different versions — so there is no "the
# repo's version" to follow; this pin is its own. Bundling here rather than on
# whoever runs the build is what makes `docker build` the whole of it, which is
# also the fourth GPL obligation below.
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
#   1. The licence texts travel with the image, in the directory below.
#   2. The version and its origin are recorded beside them.
#   3. That record names where the corresponding source is fetched from.
#   4. This Dockerfile is the whole build; anyone can reproduce it.
#
# Which licence, measured rather than taken from the package metadata: this
# build carries `--enable-gpl` AND `--enable-version3`, and `ffmpeg -L` answers
# "GNU General Public License … either version 3 of the License, or (at your
# option) any later version". So the binary is GPL-3.0-or-later. Alpine's `L:`
# field says GPL-2.0-or-later AND LGPL-2.1-or-later, which is where the
# or-later chain starts rather than where this build lands; the SOURCE file
# below records both, and all four texts travel with it as upstream ships them.
#
# The texts are copied from this repository rather than pulled at build time.
# Alpine's ffmpeg package installs no licence file of its own — measured, the
# image has none anywhere — so a build that expected to find one would meet
# none of the four while reading as though it met three.
COPY packages/ingest/container/COPYING.GPLv2 /usr/share/ffmpeg-source/COPYING.GPLv2
COPY packages/ingest/container/COPYING.GPLv3 /usr/share/ffmpeg-source/COPYING.GPLv3
COPY packages/ingest/container/COPYING.LGPLv2.1 /usr/share/ffmpeg-source/COPYING.LGPLv2.1
COPY packages/ingest/container/COPYING.LGPLv3 /usr/share/ffmpeg-source/COPYING.LGPLv3

# What this image distributes and under what terms, beside the four texts above
# rather than among them: those are FFmpeg's own, this one covers the image.
COPY THIRD-PARTY.md /usr/share/doc/breatic/THIRD-PARTY.md

# Every value is read out of the installed package rather than written here, so
# what the notice claims is what was actually installed. `c:` is the aports
# commit the package was built from, which names the recipe exactly — a branch
# moves on and stops describing this build.
#
# The licence is read twice from two sources that disagree: the package's `L:`
# field, and the binary's own `-L` output. The binary is the one that knows
# which components were compiled in, so it is quoted first and the metadata is
# recorded beside it. Reading only the metadata is how the entry in
# THIRD-PARTY.md came to say version 2 of a binary that says version 3.
RUN set -eu; \
  info=$(awk '/^P:ffmpeg$/,/^$/' /lib/apk/db/installed); \
  version=$(printf '%s\n' "$info" | sed -n 's/^V://p'); \
  declared=$(printf '%s\n' "$info" | sed -n 's/^L://p'); \
  commit=$(printf '%s\n' "$info" | sed -n 's/^c://p'); \
  upstream=$(printf '%s\n' "$version" | sed 's/-r[0-9]*$//'); \
  { \
    echo "ffmpeg $version."; \
    echo; \
    echo "The licence, as the binary itself reports it (ffmpeg -L):"; \
    ffmpeg -hide_banner -L 2>&1 | head -4 | sed 's/^/  /'; \
    echo; \
    echo "Alpine's package metadata declares: $declared."; \
    echo "That is where the or-later chain starts; the line above is where"; \
    echo "this build lands, because it carries --enable-version3."; \
    echo; \
    echo "Built by Alpine Linux from the recipe at this exact commit:"; \
    echo "  https://gitlab.alpinelinux.org/alpine/aports/-/tree/$commit/community/ffmpeg"; \
    echo; \
    echo "The program's own source for this version:"; \
    echo "  https://ffmpeg.org/releases/ffmpeg-$upstream.tar.xz"; \
    echo; \
    echo "All four licence texts are in this directory, as upstream ships them."; \
  } > /usr/share/ffmpeg-source/SOURCE

COPY --from=build /out/server.mjs /app/server.mjs

# Listening starts immediately: nothing is prepared at startup, because every
# second before the port answers is a second the request that woke this
# container spends waiting.
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
