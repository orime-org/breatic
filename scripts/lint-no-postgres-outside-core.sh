#!/usr/bin/env bash
# lint-no-postgres-outside-core — the postgres.js driver may be imported
# ONLY in @breatic/core.
#
# Rationale (2026-06-02 ADR "DB adapter unification"): postgres.js is the
# low-level PostgreSQL driver; Drizzle (the query layer) is built on top
# of it and is the project-wide adapter. core is the single home of the
# driver — it owns the connection pool factory (`createPgClient`), the
# process-wide `db` / `rawPg` singletons, the `pingDb` / `checkPgReachable`
# liveness helpers, and the integration-test client builder. Every other
# package reaches Postgres exclusively through those core exports + the
# repos, so the driver, its pool lifecycle, and its `Sql` type never leak
# across the package boundary again (collab used to hand-roll its own
# postgres.js pools — that drift is what this guard locks out).
#
# FORBIDDEN outside packages/core/src: any import of the `postgres`
# package — `from "postgres"` / `from 'postgres'` / `require("postgres")`.
# NOTE: `drizzle-orm/postgres-js` is a different specifier (the Drizzle
# adapter) and is intentionally NOT matched.
#
# EXEMPT: tests (*.test.ts / *.integration.test.ts / __tests__) may use the
# driver directly to seed / probe a throwaway container.
#
# Runs in CI and as `pnpm lint:no-postgres-outside-core`. Non-zero exit
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

# An ES import or CJS require of the bare `postgres` package. The closing
# quote right after `postgres` is what keeps `drizzle-orm/postgres-js`
# (and any other `postgres-*` specifier) from matching.
POSTGRES_IMPORT_REGEX="from ['\"]postgres['\"]|require\(['\"]postgres['\"]\)"

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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$POSTGRES_IMPORT_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-postgres-outside-core — postgres.js driver imported outside @breatic/core:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "The postgres.js driver lives only in @breatic/core (the pool" >&2
  echo "factory + db/rawPg singletons + pingDb/checkPgReachable). Reach" >&2
  echo "Postgres through those core exports and the repos — never import" >&2
  echo "the 'postgres' package directly. (drizzle-orm/postgres-js, the" >&2
  echo "Drizzle adapter, is a different specifier and is allowed.)" >&2
  exit 1
fi

echo "lint:no-postgres-outside-core — clean (postgres.js stays in @breatic/core)"
