#!/usr/bin/env bash
# lint-no-relative-import — forbid relative ('./' or '../') import
# specifiers in non-test source across every package.
#
# Rationale (CLAUDE.md prohibition list, 2026-05-29): the repo enforces a
# uniform path-alias import style. Every intra-package reference goes
# through an alias, never a relative path:
#
#   - @breatic/shared internal → @shared/*
#   - @breatic/core internal   → @core/*
#   - @breatic/domain internal → @domain/*
#   - @breatic/collab internal → @collab/*
#   - @breatic/worker internal → @worker/*
#   - @breatic/server internal → @server/*
#   - @breatic/web internal    → @web/*
#
# EVERY package uses a GLOBALLY-UNIQUE prefix (no package uses a bare
# '@/'). Rationale: a package's source may be imported into another
# package's resolution context (e.g. the server integration test imports
# worker + collab source). A per-package '@/' would collide — the
# importer's '@/' and the dependency's '@/' point at different src dirs,
# and a single alias cannot resolve both. Unique prefixes make every
# intra-package import resolve unambiguously regardless of who imports
# the source. (2026-05-29: unified server/web from '@/' to @server/@web
# so the rule has zero exceptions.)
#
# This check runs in CI (see `.github/workflows/ci.yml`) and as
# `pnpm lint:no-relative-import` locally. A non-zero exit blocks merge.
#
# Exclusions:
#   - `__tests__/` directories + `*.test.ts(x)` / `*.spec.ts(x)` —
#     test files are exempt (they're not shipped, so the runtime
#     alias-resolution concern doesn't apply; consistent with
#     lint:no-cjk / lint:no-library-logger test exclusions).
#   - Line / block comments — stripped before grepping so prose
#     references like "import { x } from './y'" in doc-comments don't
#     false-positive.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop — portable across BSD + GNU.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Matches a relative import/export specifier:
#   from './x'      from "../x"
#   import('./x')   import("../x")
#   import './x'    import "../x"
#   export ... from './x'
RELATIVE_REGEX="(from|import)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/"

SCAN_DIRS=(
  packages/shared/src
  packages/core/src
  packages/domain/src
  packages/server/src
  packages/worker/src
  packages/collab/src
  packages/web/src
)

CANDIDATES=$(find "${SCAN_DIRS[@]}" \
  -type f \
  \( -name '*.ts' -o -name '*.tsx' \) \
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
  # Strip // line comments + /* ... */ block comments (incl.
  # multi-line) before grepping, so doc-comment prose doesn't
  # false-positive. Same stripper as lint-no-library-logger.sh.
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$RELATIVE_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-relative-import — found relative imports in source:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md prohibition list, non-test source must import via a path" >&2
  echo "alias, never a relative './' or '../' path. Use the package's" >&2
  echo "alias: @shared/* (shared), @core/* (core), @domain/* (domain)," >&2
  echo "@collab/* (collab), @worker/* (worker), @server/* (server), @web/* (web)." >&2
  exit 1
fi

echo "lint:no-relative-import — clean (no relative imports in non-test source)"

