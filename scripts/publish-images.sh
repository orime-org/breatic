#!/usr/bin/env bash
# Copyright (c) 2026 Orime, Inc.
# SPDX-License-Identifier: LicenseRef-BSAL-1.0
set -euo pipefail
: "${TAG:?}" "${REVISION:?}" "${REPOSITORY:?}"
for name in backend-amd64 backend-arm64 web-amd64 web-arm64 ingestMedia-amd64; do
  [[ "$(cat "digests/$name")" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
done
for kind in backend web; do
  image="ghcr.io/$REPOSITORY"
  [[ "$kind" != web ]] || image+="-web"
  amd=$(cat "digests/$kind-amd64")
  arm=$(cat "digests/$kind-arm64")
  docker buildx imagetools create --tag "$image:$TAG" "$image@$amd" "$image@$arm"
  digest=$(docker buildx imagetools inspect "$image:$TAG" --format '{{.Manifest.Digest}}')
  docker buildx imagetools inspect "$image@$digest" --raw > "$kind-index.json"
  node scripts/release.mjs check-index "$kind-index.json" "$amd" "$arm"
  printf '%s' "$image@$digest" > "$kind-ref"
done
media="ghcr.io/$REPOSITORY-ingest-media"
media_digest=$(cat digests/ingestMedia-amd64)
# Keep the single-platform manifest unchanged; Cloudflare requires amd64.
docker buildx imagetools create --prefer-index=false --tag "$media:$TAG" "$media@$media_digest"
[[ "$(docker buildx imagetools inspect "$media:$TAG" --format '{{.Manifest.Digest}}')" == "$media_digest" ]] || exit 1
node scripts/release.mjs manifest "$TAG" "$REVISION" "$REPOSITORY" "$(cat backend-ref)" "$(cat web-ref)" "$media@$media_digest" release.json
gh release upload "$TAG" release.json
gh release edit "$TAG" --draft=false --latest=false
