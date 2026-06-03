#!/usr/bin/env bash
# add-license-headers — idempotent: prepend the SPDX copyright header to
# every first-party TypeScript source file (packages/*/src *.ts / *.tsx,
# including tests) that lacks it. shadcn vendor (components/ui) is exempt
# — third-party IP, not Orime's copyright.
#
# Re-runnable: files already carrying the header are skipped, so it is
# safe to run again after adding new files. The CI guard
# lint:no-missing-license-header is what flags a missing header.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HEADER='// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0'

added=0
while IFS= read -r f; do
  # Idempotent: skip files that already start with our copyright line.
  if head -1 "$f" | grep -qF 'Copyright (c) 2026 Orime, Inc.'; then
    continue
  fi
  { printf '%s\n\n' "$HEADER"; cat "$f"; } > "$f.lichdr.tmp"
  mv "$f.lichdr.tmp" "$f"
  added=$((added + 1))
done < <(find packages -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -path '*/src/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/components/ui/*')

echo "add-license-headers — added the SPDX header to ${added} file(s)."
