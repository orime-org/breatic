#!/usr/bin/env bash
# lint-no-library-process-exit — forbid `process.exit()` calls in
# @breatic/core, @breatic/shared and @breatic/domain production source.
#
# Rationale (CLAUDE.md "process lifecycle, library layer forbidden" mandate):
# A library knows "something went wrong" but NOT "whether the process
# should die" — only the application layer (each service entry) owns
# that lifecycle decision (server exit = permanent 503; worker exit =
# BullMQ retry chain; collab exit = hocuspocus collaboration cut). When
# a library hits a "the caller must abort the process" situation
# (startup connectivity check fails, required env var missing, ...), it
# THROWS a typed error (InfraNotReadyError etc.); the application entry
# catches it in a top-level try/catch, logs the context, and calls
# `process.exit(1)` itself.
#
# `console.*` is covered by the sibling lint-no-library-logger guard
# (console output is logging); this guard owns the process-lifecycle
# half of the same library boundary.
#
# This check runs in CI (see `.github/workflows/ci.yml`) and as
# `pnpm lint:no-library-process-exit` for local use. A non-zero exit
# blocks the PR merge.
#
# Exclusions (legitimate library uses that don't trigger):
#
#   - `__tests__/` directories + `*.test.ts` / `*.spec.ts` — test
#     code is not shipped, so the lifecycle concern doesn't apply.
#   - Line / block comments containing `process.exit` tokens — we
#     strip `// ...` and `/* ... */` regions before grepping so prose
#     references in doc-comments (e.g. "the application entry calls
#     `process.exit(1)`") don't false-positive.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op (the include filter wins), so file filtering
# uses `find` + a per-file scan loop — portable across BSD + GNU.
# (Same stripper as lint-no-library-logger.sh.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Matches a process-termination call that a library must never make.
PROCESS_EXIT_REGEX='\bprocess\.exit\b'

# Restrict the scan to library packages — server / collab / worker
# entries are the application layer and SHOULD own process exit.
SCAN_DIRS=(
  packages/core/src
  packages/shared/src
  packages/domain/src
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$PROCESS_EXIT_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-library-process-exit — found process.exit() calls in library source:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md 'process lifecycle (library forbidden)' mandate, library code" >&2
  echo "must NOT terminate the process. Throw a typed error" >&2
  echo "(InfraNotReadyError etc.) instead and let the application entry" >&2
  echo "(server / worker / collab) catch it, log the context, and decide" >&2
  echo "whether to process.exit(1)." >&2
  echo "" >&2
  echo "If a match is a legitimate exception, document the reason and add" >&2
  echo "a narrower exclusion to scripts/lint-no-library-process-exit.sh." >&2
  exit 1
fi

echo "lint:no-library-process-exit — clean (no process.exit() calls in @breatic/core, @breatic/shared or @breatic/domain)"
