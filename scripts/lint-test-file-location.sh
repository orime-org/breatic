#!/usr/bin/env bash
# lint-test-file-location — require every test file to live under a
# `__tests__/` directory, never colocated next to the source it tests.
#
# Rationale (2026-07-15, user decision): the repo standardized on the
# `__tests__/` subdirectory layout — 93% of test files already lived
# there, with a handful of colocated stragglers in core/domain/server
# that drifted only because the convention was unwritten and unguarded.
# A doc rule alone lets drift recur (that is exactly how the stragglers
# appeared); this guard is the enforcement half so a colocated test can
# never land again. The naming half (`<subject>.test.ts`) is already
# documented in docs/ARCHITECTURE.md; this check governs LOCATION only.
#
# What counts as a test file: `*.test.ts(x)` / `*.spec.ts(x)` under any
# `packages/*/src` tree. A compliant file has `__tests__` somewhere in
# its path; anything else is a violation.
#
# This check runs in CI (see `.github/workflows/ci.yml`) and as
# `pnpm lint:test-file-location` locally. A non-zero exit blocks merge.
# Pass `--self-test` to verify the checker itself (positive + negative
# samples) — wired in package.json so a broken guard fails CI too.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SCAN_DIRS=(
  packages/shared/src
  packages/core/src
  packages/domain/src
  packages/collab/src
  packages/server/src
  packages/worker/src
  packages/web/src
)

# Find every test file NOT under a __tests__/ directory. `find` filters
# on path so it is portable across BSD (macOS) + GNU (CI).
find_violations() {
  local root="$1"
  local dirs=()
  local d
  for d in "${SCAN_DIRS[@]}"; do
    [[ -d "$root/$d" ]] && dirs+=("$root/$d")
  done
  [[ ${#dirs[@]} -eq 0 ]] && return 0
  find "${dirs[@]}" \
    -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' \
       -o -name '*.spec.ts' -o -name '*.spec.tsx' \) \
    -not -path '*/__tests__/*' \
    -not -path '*/node_modules/*' \
    -not -path '*/dist/*' \
    2>/dev/null || true
}

self_test() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/packages/core/src/foo/__tests__"
  # Negative sample: a compliant test under __tests__/ must NOT be flagged.
  : > "$tmp/packages/core/src/foo/__tests__/bar.test.ts"
  local clean
  clean="$(find_violations "$tmp")"
  if [[ -n "$clean" ]]; then
    echo "SELF-TEST FAIL: compliant __tests__/ file was flagged:" >&2
    echo "$clean" >&2
    exit 2
  fi
  # Positive sample: a colocated test MUST be flagged.
  : > "$tmp/packages/core/src/foo/bar.test.ts"
  local dirty
  dirty="$(find_violations "$tmp")"
  if [[ "$dirty" != *"foo/bar.test.ts"* ]]; then
    echo "SELF-TEST FAIL: colocated test was NOT flagged" >&2
    exit 2
  fi
  echo "lint:test-file-location — self-test passed (catches colocated, allows __tests__/)"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

VIOLATIONS="$(find_violations "$REPO_ROOT")"

if [[ -n "$VIOLATIONS" ]]; then
  echo "lint:test-file-location — found colocated test files (must live under __tests__/):" >&2
  echo "" >&2
  printf '%s\n' "$VIOLATIONS" | sed "s#^$REPO_ROOT/##" >&2
  echo "" >&2
  echo "Every *.test.ts(x) / *.spec.ts(x) must live in a __tests__/ directory," >&2
  echo "not next to the source it tests. Move the file into a sibling __tests__/" >&2
  echo "folder (git mv) and deepen its relative imports by one level." >&2
  exit 1
fi

echo "lint:test-file-location — clean (all test files under __tests__/)"
