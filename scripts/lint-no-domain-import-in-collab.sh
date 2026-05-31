#!/usr/bin/env bash
# lint-no-domain-import-in-collab — forbid @breatic/collab from
# importing @breatic/domain (the @domain alias or the package name).
#
# Rationale (2026-05-31 ADR "二次调整:抽离 @breatic/domain"): the
# backend dependency graph is —
#
#   shared  ←  core  ←  { domain, collab }
#                          ↑
#                  server / worker
#
# `@breatic/domain` holds the server+worker-shared AIGC business
# (credit / task / node-history / agent / model-catalog / canvas-lock).
# collab is a separate process that does Yjs collaboration and must
# NEVER touch that business — it depends on core + shared ONLY. Letting
# collab reach into domain would re-introduce exactly the boundary rot
# this adjustment removes (collab pulling business it has no need for,
# coupling the collab process to the AIGC billing/task internals).
#
# The reverse direction (domain importing collab) is already banned by
# lint-no-app-import-in-core (domain is a library, can't import any app
# package). This guard covers the one remaining edge: an APP (collab)
# importing the server/worker-only library (domain).
#
# Runs in CI (`.github/workflows/ci.yml`) and as
# `pnpm lint:no-domain-import-in-collab` locally. A non-zero exit
# blocks the PR.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop (portable across BSD + GNU). `//` and `/* ... */` comments
# are stripped before grepping so a doc-comment naming @domain won't
# false-positive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Module specifier importing domain: the @domain/* internal alias OR the
# @breatic/domain package name (root or subpath). The quote before the
# specifier is the anchor.
DOMAIN_IMPORT_REGEX='["'\''](@breatic/domain|@domain/)'

SCAN_DIRS=(
  packages/collab/src
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$DOMAIN_IMPORT_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-domain-import-in-collab — collab imports @breatic/domain:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "@breatic/collab must NOT import @breatic/domain. domain holds" >&2
  echo "server+worker-only AIGC business (credit / task / node-history /" >&2
  echo "agent / model-catalog / canvas-lock); collab depends on core +" >&2
  echo "shared ONLY. If collab genuinely needs shared logic, it belongs" >&2
  echo "in core (used by collab + another service), not domain. See ADR" >&2
  echo "二次调整:抽离 @breatic/domain + root CLAUDE.md 依赖图." >&2
  exit 1
fi

echo "lint:no-domain-import-in-collab — clean (collab does not import @breatic/domain)"
