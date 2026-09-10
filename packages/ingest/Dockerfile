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
#   1. The licence text travels with the image, in the directory below.
#   2. The version and its origin are recorded beside it.
#   3. That file names where the corresponding source is fetched from.
#   4. This Dockerfile is the whole build; anyone can reproduce it.
RUN mkdir -p /usr/share/ffmpeg-source \
  && ffmpeg -version | head -1 > /usr/share/ffmpeg-source/VERSION \
  && apk info -w ffmpeg >> /usr/share/ffmpeg-source/VERSION \
  && printf '%s\n' \
    'ffmpeg in this image is the Alpine Linux package, built from:' \
    '  https://gitlab.alpinelinux.org/alpine/aports/-/tree/master/community/ffmpeg' \
    'The exact package version is in VERSION beside this file. Source for that' \
    'version is available from the Alpine package archive:' \
    '  https://dl-cdn.alpinelinux.org/alpine/v3.22/community/' \
    > /usr/share/ffmpeg-source/README \
  && cp /usr/share/licenses/ffmpeg/* /usr/share/ffmpeg-source/ 2>/dev/null || true

COPY --from=build /out/server.mjs /app/server.mjs

# Listening starts immediately: nothing is prepared at startup, because every
# second before the port answers is a second the request that woke this
# container spends waiting.
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
