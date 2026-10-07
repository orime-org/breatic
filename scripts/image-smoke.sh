#!/usr/bin/env bash
# Copyright (c) 2026 Orime, Inc.
# SPDX-License-Identifier: LicenseRef-BSAL-1.0
set -euo pipefail
: "${TEST_IMAGE:?}" "${IMAGE_KIND:?}" "${ARCH:?}" "${VERSION:?}" "${REVISION:?}"
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$TEST_IMAGE")" == "linux/$ARCH" ]] || exit 1
native_arch=$(docker info --format '{{.Architecture}}')
case "$native_arch" in x86_64) native_arch=amd64 ;; aarch64) native_arch=arm64 ;; esac
[[ "$native_arch" == "$ARCH" ]] || exit 1
metadata=/app/build-info.json
[[ "$IMAGE_KIND" != web ]] || metadata=/usr/share/nginx/html/app-version.json
docker run --rm --entrypoint cat "$TEST_IMAGE" "$metadata" > image-info.json
docker image inspect "$TEST_IMAGE" > image-inspect.json
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const info = JSON.parse(readFileSync('image-info.json', 'utf8'));
const [image] = JSON.parse(readFileSync('image-inspect.json', 'utf8'));
assert.equal(info.releaseVersion, process.env.VERSION);
assert.equal(info.revision, process.env.REVISION);
assert.equal(image.Config.Labels['org.opencontainers.image.version'], info.releaseVersion);
assert.equal(image.Config.Labels['org.opencontainers.image.revision'], info.revision);
JS
case "$IMAGE_KIND" in
  backend)
    docker run --rm --entrypoint node "$TEST_IMAGE" -e "if(process.arch !== '${ARCH/amd64/x64}') process.exit(1)"
    docker run --rm --network none --entrypoint sh "$TEST_IMAGE" -c \
      'ffmpeg -v error -f lavfi -i color=size=64x48:rate=2 -t 1 -y /tmp/check.mp4 && ffprobe -v error -show_entries stream=width,height /tmp/check.mp4'
    docker run --rm -v "$PWD/scripts/backend-sourcemaps.mjs:/tmp/verify-maps.mjs:ro" --entrypoint node "$TEST_IMAGE" /tmp/verify-maps.mjs /app --installed
    ;;
  web)
    container=$(docker run -d --network none --add-host server:127.0.0.1 --add-host collab:127.0.0.1 "$TEST_IMAGE")
    trap 'docker rm -f "$container" >/dev/null' EXIT
    for attempt in {1..20}; do
      if docker exec "$container" wget -qO- http://127.0.0.1/app-version.json > served-info.json; then break; fi
      sleep 1
    done
    cmp image-info.json served-info.json
    ;;
  ingestMedia)
    docker run --rm --entrypoint sh "$TEST_IMAGE" -c \
      'test -s /usr/share/ffmpeg-source/COPYING.GPLv2 && test -s /usr/share/ffmpeg-source/COPYING.LGPLv2.1 && test -s /usr/share/ffmpeg-source/SOURCE && test -s /usr/share/doc/breatic/THIRD-PARTY.md'
    docker run --rm --network none -v "$PWD/scripts/ingest-media-smoke.mjs:/tmp/media-smoke.mjs:ro" --entrypoint node "$TEST_IMAGE" /tmp/media-smoke.mjs
    ;;
  *) echo 'Unknown image kind' >&2; exit 1 ;;
esac
