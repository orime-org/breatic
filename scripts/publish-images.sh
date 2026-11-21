#!/usr/bin/env bash
# Copyright (c) 2026 Orime, Inc.
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
: "${TAG:?}" "${REVISION:?}" "${REPOSITORY:?}"
for name in backend-amd64 backend-arm64 web-amd64 web-arm64 ingestMedia-amd64 ingestWebReader-amd64 ingestWebAnimation-amd64 ingestWebAnimationRender-amd64; do
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
# The four container images keep their single-platform manifests unchanged;
# Cloudflare requires amd64.
refs=()
for pair in ingestMedia:ingest-media ingestWebReader:ingest-web-reader ingestWebAnimation:ingest-web-animation ingestWebAnimationRender:ingest-web-animation-render; do
  image="ghcr.io/$REPOSITORY-${pair#*:}"
  digest=$(cat "digests/${pair%%:*}-amd64")
  docker buildx imagetools create --prefer-index=false --tag "$image:$TAG" "$image@$digest"
  [[ "$(docker buildx imagetools inspect "$image:$TAG" --format '{{.Manifest.Digest}}')" == "$digest" ]] || exit 1
  refs+=("$image@$digest")
done
node scripts/release.mjs manifest "$TAG" "$REVISION" "$REPOSITORY" "$(cat backend-ref)" "$(cat web-ref)" "${refs[@]}" release.json
gh release upload "$TAG" release.json
gh release edit "$TAG" --draft=false --latest=false
