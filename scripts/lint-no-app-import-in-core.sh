#!/usr/bin/env bash
# lint-no-app-import-in-core — forbid library packages (@breatic/core,
# @breatic/shared) from importing any application package
# (@server / @worker / @collab / @web).
#
# Rationale (2026-05-31 ADR "后端收敛为模块化单体"): the backend is a
# modular monolith with a strict layer direction —
#
#   app (server / worker / collab / web)  →  core / shared
#
# A library must NEVER import an application package: that would invert
# the dependency (the shared kernel reaching up into a specific
# service), couple core to a service's internals, and create import
# cycles. This guard is the machine enforcement of that direction —
# belt for the PR2 migration (when ~15 server-private modules move out
# of core) so the convergence can't silently rot back into a fat core.
#
# Runs in CI (`.github/workflows/ci.yml`) and as
# `pnpm lint:no-app-import-in-core` locally. A non-zero exit blocks the
# PR.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop. `//` and `/* ... */` comments are stripped before grepping
# so a doc-comment naming a forbidden alias (e.g. this rationale quoted
# in a package CLAUDE.md is markdown, not scanned; a `.ts` comment
# mentioning `@server` won't false-positive).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Module specifier starting with an application-package alias. Matches
# `from "@server/..."`, `import "@worker/..."`, `import("@collab/...")`,
# `from '@web/...'`, etc. — the quote before the alias is the anchor.
APP_IMPORT_REGEX='["'\'']@(server|worker|collab|web)/'

# Library packages only — applications are ALLOWED to import each other's
# bans live elsewhere (the strict no-cross-service rule), not here.
SCAN_DIRS=(
  packages/core/src
  packages/shared/src
)

CANDIDATES=$(find "${SCAN_DIRS[@]}" \
  -type f \
  -name '*.ts' \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$APP_IMPORT_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-app-import-in-core — library package imports an application package:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "@breatic/core and @breatic/shared must NOT import @server /" >&2
  echo "@worker / @collab / @web. The dependency direction is" >&2
  echo "app → core/shared, never the reverse. If a service needs shared" >&2
  echo "logic, move that logic INTO core (it's then genuinely shared);" >&2
  echo "if it's service-private, it stays in the service, not pulled" >&2
  echo "from core. See ADR 后端收敛为模块化单体 + root CLAUDE.md 三层边界." >&2
  exit 1
fi

echo "lint:no-app-import-in-core — clean (no app imports in @breatic/core or @breatic/shared)"
