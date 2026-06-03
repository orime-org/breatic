#!/usr/bin/env bash
# lint-no-missing-license-header — every first-party TypeScript source
# file under packages/*/src (*.ts / *.tsx, including tests) must start
# with the SPDX copyright header. shadcn vendor (components/ui) is exempt
# (third-party IP). dist / node_modules are excluded.
#
# Runs in CI and as `pnpm lint:no-missing-license-header`. Non-zero exit
# blocks the PR. Add the header to new files with
# `scripts/add-license-headers.sh` (idempotent).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MISSING=""
while IFS= read -r f; do
  if ! head -1 "$f" | grep -qF 'Copyright (c) 2026 Orime, Inc.'; then
    MISSING+="${f}"$'\n'
  fi
done < <(find packages -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -path '*/src/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/components/ui/*')

if [[ -n "$MISSING" ]]; then
  echo "lint:no-missing-license-header — files missing the SPDX copyright header:" >&2
  printf '%s' "$MISSING" >&2
  echo "" >&2
  echo "Every first-party packages/*/src .ts/.tsx file must start with the two-line header." >&2
  echo "Run scripts/add-license-headers.sh to add it (idempotent)." >&2
  exit 1
fi

echo "lint:no-missing-license-header — clean (all first-party src files carry the SPDX header)"
