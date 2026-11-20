#!/usr/bin/env bash
# Copyright (c) 2026 Orime, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
#
# Run the media container's Node tests inside the image built from packages/ingest/Dockerfile, so FFmpeg is the
# production build (8.0 on Alpine) rather than the developer's local one (inner#1306 test plan §91 D-5).
#
# The image under test is built unchanged; the tests run in a throwaway container started from it, which adds npm and
# pnpm to install the workspace's test dependencies for Linux. Nothing is pushed and the checkout is mounted read-only.
#
# Usage (from the repository root):
#   packages/ingest/scripts/test-container-in-image.sh [vitest file filters...]
# Defaults to every container Node test (container/__tests__). Needs Docker and network access for the install.
# IMAGE names the image (default breatic-ingest-media-test:local); BUILD=0 skips the build and uses IMAGE as it is.
# DOCKERFILE picks the Dockerfile to build (default packages/ingest/Dockerfile).
set -euo pipefail

root=$(git rev-parse --show-toplevel)
platform=${PLATFORM:-linux/amd64}
dockerfile=${DOCKERFILE:-$root/packages/ingest/Dockerfile}
image=${IMAGE:-breatic-ingest-media-test:local}
pnpm_version=$(node -p "require('$root/package.json').packageManager.split('@')[1]")
filters=("$@")
[[ ${#filters[@]} -gt 0 ]] || filters=(container/__tests__)

# BUILD=0 reuses an image already built from this Dockerfile (the OpenCV stage takes long under emulation).
[[ "${BUILD:-1}" == 0 ]] || docker build --platform "$platform" -f "$dockerfile" -t "$image" "$root"

docker run --rm --platform "$platform" -v "$root:/repo:ro" -e PNPM_VERSION="$pnpm_version" \
  --entrypoint /bin/sh "$image" -c '
  set -eu
  ffmpeg -hide_banner -version | head -1
  apk add --no-cache npm git tar >/dev/null
  npm install -g "pnpm@${PNPM_VERSION}" >/dev/null
  mkdir /work
  cd /repo && git -c safe.directory=/repo ls-files -z --cached --others --exclude-standard | tar --null -T - -cf - | tar -xf - -C /work
  cd /work
  pnpm install --frozen-lockfile --filter @breatic/ingest... >/dev/null
  cd packages/ingest
  pnpm exec vitest run --project node "$@"
' sh "${filters[@]}"
