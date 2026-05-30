#!/usr/bin/env bash
# lint-no-core-process-env — forbid `process.env` access in
# @breatic/core and @breatic/shared production source.
#
# Rationale (CLAUDE.md "core / shared 不读环境变量" mandate,
# 2026-05-30): reading environment variables is configuration
# ACQUISITION, which belongs to the application layer (server /
# worker / collab entries = the composition root). Library packages
# receive already-validated config injected via `initCore(rawEnv)`
# at startup and read it through the `env` Proxy / `getConfig()` /
# `getRawEnvVar()` accessors — they never touch the `process.env`
# global themselves. This is the same "library doesn't make
# application decisions" principle that bans logger.* and
# process.exit() in library code.
#
# `process.cwd()` is NOT forbidden — it reads the working directory,
# not the environment (used by findMonorepoRoot's Docker fallback).
#
# This check runs in CI and as `pnpm lint:no-core-process-env`. A
# non-zero exit blocks PR merge.
#
# Exclusions:
#   - `__tests__/` directories + `*.test.ts` / `*.spec.ts` — test
#     code may set/read process.env to drive the injection boundary.
#   - Line / block comments — prose references don't false-positive.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop rather than grep's own flags (portable across BSD + GNU).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Match `process.env` (property access or bracket index). `process.cwd`
# and other `process.*` members are fine — only `.env` is forbidden.
ENV_REGEX='\bprocess\.env\b'

# Library packages only — application entries (server/worker/collab)
# ARE the composition root and SHOULD read process.env.
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
  # Strip // line comments + /* ... */ block comments (single- and
  # multi-line) before grepping, so doc-comment prose mentioning
  # `process.env` doesn't false-positive. `sed`/`awk` are portable.
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$ENV_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-core-process-env — found process.env access in library source:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md 'core / shared 不读环境变量' mandate, library" >&2
  echo "code must NOT read process.env. The application entry reads" >&2
  echo "process.env once and injects via initCore(rawEnv); library" >&2
  echo "code reads the injected config through the env Proxy /" >&2
  echo "getConfig() / getRawEnvVar() accessors in @core/config." >&2
  exit 1
fi

echo "lint:no-core-process-env — clean (no process.env in @breatic/core or @breatic/shared)"
