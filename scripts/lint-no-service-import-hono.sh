#!/usr/bin/env bash
# lint-no-service-import-hono — forbid the domain service layer from
# importing the Hono web framework.
#
# Rationale (CLAUDE.md 禁止清单 #2 "Service import hono" + 后端两个维度
# 包内分层): the route layer (server route / worker handler / collab hook)
# translates a protocol request into a business call; the domain service
# layer writes business logic and must stay protocol-agnostic. A service
# that imports `hono` (Context / Hono / hono/* helpers) or `@hono/*` has
# leaked the transport framework into the business layer — the exact
# coupling 禁#2 forbids. A service that needs to signal an HTTP-flavored
# outcome throws a typed `AppError(status, msg)`; the route-layer handler
# maps it to a response. The service never touches hono.
#
# SCOPE: every `*.service.ts` across all packages (the service-layer
# naming convention). Route files (`*.route.ts` / handlers / hooks) are
# the protocol boundary and ARE allowed to import hono — they are not
# scanned.
#
# Implementation notes (mirror lint-no-relative-import.sh):
#   - The file list is built with `find` (portable across BSD + GNU;
#     avoids the grep --include/--exclude ordering trap on macOS).
#   - `//` and `/* ... */` comments are stripped before grepping so a
#     doc-comment mentioning hono won't false-positive.
#   - Test files (`*.test.ts`, `__tests__/`) are exempt — they may import
#     hono to build a test app.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:no-service-import-hono`. A non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Matches an import/export whose module specifier is hono or @hono/*:
#   import { Context } from 'hono'
#   import type { Hono } from "hono"
#   from 'hono/jsx'      from "@hono/node-server"
#   import('hono')       import 'hono'
HONO_REGEX="(from|import)[[:space:]]*\(?[[:space:]]*['\"]@?hono(/|['\"])"

CANDIDATES=$(find packages \
  -type f \
  -name '*.service.ts' \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
  -not -name '*.spec.ts' \
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$HONO_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-service-import-hono — service layer imports the hono framework:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md 禁止清单 #2, a *.service.ts file must stay" >&2
  echo "protocol-agnostic — it must NOT import hono / @hono/*. The route" >&2
  echo "layer (route / handler / hook) owns the protocol; the service" >&2
  echo "throws a typed AppError(status, msg) and the route maps it to a" >&2
  echo "response. Move the hono dependency to the route layer." >&2
  exit 1
fi

echo "lint:no-service-import-hono — clean (service layer has no hono imports)"
