#!/usr/bin/env bash
# lint-storage-key-prefix — every browser-persisted (localStorage /
# sessionStorage) key must carry the `breatic.` prefix.
#
# Rationale (user decision 2026-06-08): persisted keys share the origin's
# storage namespace with browser extensions and any future sibling app on the
# same domain, so a bare key like `rail.myStudios` risks a silent collision.
# The web app routes every key through the central registry
# `@web/lib/storage-keys` (`STORAGE_KEYS.*`), whose values all carry the
# `breatic.` prefix. This guard catches any key that bypasses the registry
# with a non-prefixed string literal.
#
# What it flags: a string literal passed as the FIRST argument to
# localStorage/sessionStorage `.getItem` / `.setItem` / `.removeItem` that does
# not start with `breatic.`. Callsites that pass a variable (e.g.
# `STORAGE_KEYS.locale` or a hook parameter) are not literals and never trip
# the guard — that is the intended path through the registry.
#
# Scope: packages/web/src **/*.ts(x) (non-test) + the pre-React inline script in
# src/index.html. That inline script runs before the module graph loads and so
# cannot import the registry; it hardcodes the prefixed literal, which this
# guard still prefix-checks. Comments are stripped before scanning so example
# snippets in doc-comments don't false-positive.
#
# This check runs in CI (see `.github/workflows/ci.yml`) and as
# `pnpm lint:storage-key-prefix` locally. A non-zero exit blocks merge.
#
# Implementation note: BSD grep on macOS treats `--exclude` after `--include`
# as a no-op, so file filtering uses `find` + a per-file scan loop — portable
# across BSD + GNU. (Same pattern as lint-no-relative-import.sh.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# A localStorage/sessionStorage key access whose first argument is a string
# literal: localStorage.getItem('x') / sessionStorage.setItem("x", v) / .removeItem('x')
ACCESS_LITERAL="(localStorage|sessionStorage)[[:space:]]*\.[[:space:]]*(getItem|setItem|removeItem)[[:space:]]*\([[:space:]]*['\"]"
# The compliant subset: that same access where the literal starts with breatic.
ACCESS_PREFIXED="(localStorage|sessionStorage)[[:space:]]*\.[[:space:]]*(getItem|setItem|removeItem)[[:space:]]*\([[:space:]]*['\"]breatic\."

CANDIDATES=$(find packages/web/src \
  -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.html' \) \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
  -not -name '*.test.tsx' \
  -not -name '*.spec.ts' \
  -not -name '*.spec.tsx' \
  2>/dev/null || true)

MATCHES=""
for file in $CANDIDATES; do
  # Strip // line comments + /* ... */ block comments (incl. multi-line)
  # before grepping, so doc-comment prose doesn't false-positive. Same
  # stripper as lint-no-relative-import.sh.
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
  hits=$(printf '%s\n' "$cleaned" \
    | grep -nE "$ACCESS_LITERAL" \
    | grep -vE "$ACCESS_PREFIXED" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:storage-key-prefix — found persisted keys without the 'breatic.' prefix:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Every localStorage / sessionStorage key must carry the 'breatic.' prefix" >&2
  echo "(user decision 2026-06-08). Add the key to the central registry" >&2
  echo "packages/web/src/lib/storage-keys.ts and reference STORAGE_KEYS.* at the" >&2
  echo "callsite instead of hardcoding a bare key string." >&2
  exit 1
fi

echo "lint:storage-key-prefix — clean (every persisted key carries the 'breatic.' prefix)"
