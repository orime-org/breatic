#!/usr/bin/env bash
# lint-no-ioredis-outside-core — the ioredis driver may be imported ONLY
# in @breatic/core.
#
# Rationale (2026-06-02 Redis adapter unification plan, the Redis sibling
# of the DB-adapter unification): ioredis is the low-level Redis driver. core is
# its single home — it owns the client factory (`createRedisClient`), the
# per-process singletons (`getRedis` / `getQueueRedis` / `getStreamRedis`),
# the `pingRedis` liveness helper, AND re-exports the `Redis` *type*
# (`export type { Redis } from "ioredis"`). Every other package reaches
# Redis exclusively through those core exports, so the driver and its
# `Redis` type never leak across the package boundary again.
#
# Redis is multi-connection by protocol (pub/sub + blocking XREAD +
# BullMQ + Hocuspocus each need a dedicated socket), so unlike postgres
# the *connections* are NOT collapsed — collab still creates dedicated
# subscriber / stream clients via core's `createRedisClient` factory.
# What this guard locks is the *driver package*: no package but core may
# `import ... from "ioredis"`.
#
# FORBIDDEN outside packages/core/src: any import of the `ioredis`
# package — `from "ioredis"` / `from 'ioredis'` / `require("ioredis")`.
#
# EXEMPT: tests (*.test.ts / *.integration.test.ts / __tests__) may type
# a mock client against the driver directly.
#
# Runs in CI and as `pnpm lint:no-ioredis-outside-core`. Non-zero exit
# blocks the PR.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop (portable across BSD + GNU). `//` and `/* ... */` comments
# are stripped before grepping so a doc-comment naming the package
# won't false-positive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# An ES import or CJS require of the bare `ioredis` package.
IOREDIS_IMPORT_REGEX="from ['\"]ioredis['\"]|require\(['\"]ioredis['\"]\)"

# Every package EXCEPT core.
SCAN_DIRS=(
  packages/shared/src
  packages/server/src
  packages/worker/src
  packages/collab/src
  packages/domain/src
  packages/web/src
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
  cleaned=$(sed -e 's@//.*$@@' "$file" \
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$IOREDIS_IMPORT_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-ioredis-outside-core — ioredis driver imported outside @breatic/core:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "The ioredis driver lives only in @breatic/core (the client" >&2
  echo "factory + getRedis/getQueue/getStream singletons + pingRedis +" >&2
  echo "the re-exported Redis type). Reach Redis through those core" >&2
  echo "exports — never import the 'ioredis' package directly. Type a" >&2
  echo "client ref with \`import type { Redis } from \"@breatic/core\"\`." >&2
  exit 1
fi

echo "lint:no-ioredis-outside-core — clean (ioredis stays in @breatic/core)"
