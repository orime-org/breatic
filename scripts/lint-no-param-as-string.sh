#!/usr/bin/env bash
# lint-no-param-as-string — forbid `c.req.param(...) as string` in
# production source.
#
# Rationale (2026-05-30): Hono's `c.req.param(name)` already resolves
# to `string` for matched routes, so `as string` on it is a redundant
# cast that lies about a possible `undefined`. Two correct shapes:
#
#   1. For the project UUID behind `requireRole(...)`, read the
#      middleware-validated value: `getProjectId(c)` (see
#      `server/middleware/role.ts`).
#   2. For other route params, just read `c.req.param(name)` directly —
#      no cast needed. If a future Hono version ever returns
#      `string | undefined`, the fix is a presence guard
#      (`const x = c.req.param(name); if (!x) throw ...`), never `as`.
#
# This is a fast, type-info-free guard that runs in `lint:no-*` CI
# alongside the type-aware `no-unnecessary-type-assertion` eslint rule
# — belt-and-suspenders so the lie can't sneak back even in a context
# the eslint rule can't reason about.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop rather than grep's own flags — portable across BSD + GNU.
# `//` and `/* ... */` comments are stripped before grepping so a
# doc-comment mentioning the forbidden pattern (e.g. the JSDoc on
# `getProjectId`) does not false-positive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# `req.param(...) as string` where the cast ends the expression
# (followed by a non-identifier / non-`[` char or end of line). This
# avoids flagging legitimate `as string[]` array casts.
PARAM_REGEX='req\.param\([^)]*\) as string([^[A-Za-z]|$)'

# Scan every package's production source. The pattern is specific
# enough (Hono `req.param`) that it won't false-positive outside HTTP
# route code, but scanning everything future-proofs new Hono usage.
SCAN_DIRS=()
for d in packages/*/src; do
  [[ -d "$d" ]] && SCAN_DIRS+=("$d")
done

CANDIDATES=$(find "${SCAN_DIRS[@]}" \
  -type f \
  \( -name '*.ts' -o -name '*.tsx' \) \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
  -not -name '*.test.tsx' \
  -not -name '*.spec.ts' \
  2>/dev/null || true)

MATCHES=""
for file in $CANDIDATES; do
  cleaned=$(sed -e 's@//.*$@@' -e 's@/\*[^*]*\*/@@g' "$file" \
    | awk '
        BEGIN { in_block = 0 }
        {
          line = $0
          while (length(line) > 0) {
            if (in_block) {
              i = index(line, "*/")
              if (i == 0) { line = ""; break }
              line = substr(line, i + 2)
              in_block = 0
            } else {
              i = index(line, "/*")
              if (i == 0) { print line; break }
              print substr(line, 1, i - 1)
              line = substr(line, i + 2)
              in_block = 1
            }
          }
        }
      ')
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$PARAM_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-param-as-string — found redundant 'c.req.param(...) as string':" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Hono's c.req.param(name) is already 'string' for a matched" >&2
  echo "route — the 'as string' is redundant + dishonest. Use" >&2
  echo "getProjectId(c) for the :pid behind requireRole, or just read" >&2
  echo "c.req.param(name) directly. Never cast a route param to string." >&2
  exit 1
fi

echo "lint:no-param-as-string — clean (no 'c.req.param(...) as string')"
