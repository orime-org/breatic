#!/usr/bin/env bash
# lint-no-library-logger — forbid `logger.*` and `console.*` calls in
# @breatic/core, @breatic/shared and @breatic/domain production source.
#
# Rationale (CLAUDE.md "server-side industrial-grade standards" mandate, 2026-05-27):
# Library packages don't decide what to log — only the application
# layer (server / collab / worker entries) has the full context
# (userId / requestId / projectId etc.) needed to log usefully and
# the lifecycle authority to act on what's logged. Library code
# either:
#
#   1. Throws (raw error or typed AppError / InfraNotReadyError
#      / etc.) so the application catch sees it.
#   2. When throwing is impossible (HTTP/RPC handler that would
#      crash the process, third-party library using exceptions to
#      signal a business "not found"), returns a sentinel value
#      (`{ sent: false, reason }`, `{ exists: false }`, etc.) and
#      lets the caller log + branch.
#
# Audit logs that used to live in services (`user_registered`,
# `payment_completed`, etc.) move to the route handler that called
# the service. EventEmitter `.on('error', ...)` listeners attach
# at the application entry, not inside library factories.
#
# This check runs in CI (see `.github/workflows/ci.yml`) and as
# `pnpm lint:no-library-logger` for local use. A non-zero exit
# blocks the PR merge.
#
# Exclusions (legitimate library uses that don't trigger):
#
#   - `__tests__/` directories — test code may mock + spy on the
#     logger as part of regression tests for the rule itself
#     (e.g. `packages/core/src/infra/__tests__/redis.test.ts`).
#   - `logger.ts` files — the logger module itself defines the
#     primitives that the rule forbids using elsewhere.
#   - `*.test.ts` / `*.spec.ts` — same as `__tests__/`.
#   - Line / block comments containing `logger.` tokens — we strip
#     `// ...` and `/* ... */` regions before grepping so prose
#     references in doc-comments don't false-positive.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op (the include filter wins), so file
# filtering uses `find` + a per-file scan loop rather than grep's
# own `--exclude` flags — that's portable across BSD + GNU.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Logger method names that count as a violation. `trace` and
# `fatal` are pino-specific but a hypothetical library using them
# would still violate the mandate, so we include them. `console.*`
# counts too — CLAUDE.md treats console output as logging ("console
# also counts as a log; forbidden in the library layer"), so a
# library reaching for console.{log,error,warn,...} violates the same
# "library must not log" mandate.
LOGGER_REGEX='\blogger\.(info|warn|error|debug|fatal|trace)\b|\bconsole\.[a-zA-Z]+'

# Restrict the scan to library packages — server / collab / worker
# entries are the application layer and SHOULD log.
SCAN_DIRS=(
  packages/core/src
  packages/shared/src
  packages/domain/src
)

# Collect candidate files via find (portable across BSD + GNU).
# Exclusions:
#   -path '*/__tests__/*'  — entire test directories
#   -name '*.test.ts'      — co-located test files
#   -name '*.spec.ts'      — alternative spec naming
#   -name 'logger.ts'      — the logger module itself
CANDIDATES=$(find "${SCAN_DIRS[@]}" \
  -type f \
  -name '*.ts' \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
  -not -name '*.spec.ts' \
  -not -name 'logger.ts' \
  2>/dev/null || true)

MATCHES=""
for file in $CANDIDATES; do
  # Strip /* ... */ block comments (single-line form only; the
  # multi-line stripper below catches the rest) and // ... line
  # comments, then grep for the violation. `sed` is portable
  # across BSD (macOS) and GNU.
  cleaned=$(sed -e 's@//.*$@@' -e 's@/\*[^*]*\*/@@g' "$file" \
    | awk '
        BEGIN { in_block = 0 }
        {
          line = $0
          # Multi-line /* ... */ stripper. Tracks block state
          # across lines so JSDoc and other multi-line comments
          # do not leak their "logger." prose into the scan.
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$LOGGER_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-library-logger — found logger.* calls in library source:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md 'core and shared must not log' mandate, library" >&2
  echo "code must either throw or return a sentinel — never call" >&2
  echo "logger.{info,warn,error,debug,fatal,trace} or console.*. Move" >&2
  echo "audit logs to the application boundary (server route handler," >&2
  echo "collab hook, worker job handler) where userId / requestId" >&2
  echo "context is available." >&2
  echo "" >&2
  echo "If a match is a legitimate exception, document the reason" >&2
  echo "and add a narrower exclusion to scripts/lint-no-library-logger.sh." >&2
  exit 1
fi

echo "lint:no-library-logger — clean (no logger.* or console.* calls in @breatic/core, @breatic/shared or @breatic/domain)"
