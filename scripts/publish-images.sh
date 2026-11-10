#!/usr/bin/env bash
# Copyright (c) 2026 Orime, Inc.
# SPDX-License-Identifier: Elastic-2.0
set -euo pipefail
: "${TAG:?}" "${REVISION:?}" "${REPOSITORY:?}"
for name in backend-amd64 backend-arm64 web-amd64 web-arm64 ingestMedia-amd64 ingestWebReader-amd64 ingestWebAnimation-amd64; do
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
# The three container images keep their single-platform manifests unchanged;
# Cloudflare requires amd64.
media="ghcr.io/$REPOSITORY-ingest-media"
media_digest=$(cat digests/ingestMedia-amd64)
docker buildx imagetools create --prefer-index=false --tag "$media:$TAG" "$media@$media_digest"
[[ "$(docker buildx imagetools inspect "$media:$TAG" --format '{{.Manifest.Digest}}')" == "$media_digest" ]] || exit 1
webreader="ghcr.io/$REPOSITORY-ingest-web-reader"
webreader_digest=$(cat digests/ingestWebReader-amd64)
docker buildx imagetools create --prefer-index=false --tag "$webreader:$TAG" "$webreader@$webreader_digest"
[[ "$(docker buildx imagetools inspect "$webreader:$TAG" --format '{{.Manifest.Digest}}')" == "$webreader_digest" ]] || exit 1
animation="ghcr.io/$REPOSITORY-ingest-web-animation"
animation_digest=$(cat digests/ingestWebAnimation-amd64)
docker buildx imagetools create --prefer-index=false --tag "$animation:$TAG" "$animation@$animation_digest"
[[ "$(docker buildx imagetools inspect "$animation:$TAG" --format '{{.Manifest.Digest}}')" == "$animation_digest" ]] || exit 1
node scripts/release.mjs manifest "$TAG" "$REVISION" "$REPOSITORY" "$(cat backend-ref)" "$(cat web-ref)" "$media@$media_digest" "$webreader@$webreader_digest" "$animation@$animation_digest" release.json
gh release upload "$TAG" release.json
gh release edit "$TAG" --draft=false --latest=false
