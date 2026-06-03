#!/usr/bin/env bash
# lint-no-raw-sql-outside-repo — forbid raw database access outside
# repository files in @breatic/core, @breatic/domain, @breatic/server
# and @breatic/collab (which after the 2026-06-03 yjs two-DB cutover
# hosts the yjs_documents repo — scanned to keep any raw SQL in *.repo.ts).
#
# PR4 (the domain-extraction follow-up) note: the credit / task /
# node-history repos moved to @breatic/domain, so domain/src is scanned
# too — "one table, one repo home"
# now spans all three backend packages. Combined with the package
# boundary guards (only @breatic/domain defines the credit/task/
# node-history repos), this is the table-ownership enforcement: those
# tables' SQL can only live in their domain repo.
#
# Rationale (2026-05-31 ADR "the domain-extraction follow-up", second-layer
# CI guard): a table's data access (its SQL) must live in exactly one repo
# module — "one table, one repo home". The auth-unification drift happened precisely because the
# project-role query existed in two places (server projectAuth.service
# + a hand-rolled raw-SQL copy in collab). This guard keeps every
# raw query in a `*.repo.ts` file so the SQL for a table can never
# scatter (and drift) across services again.
#
# FORBIDDEN outside `*.repo.ts`:
#   - the postgres.js tagged template  sql`...`  /  rawPg`...`
#   - the Drizzle query builders  db.select / db.insert / db.update /
#     db.delete
#
# ALLOWED everywhere (service-level orchestration, not table access):
#   - db.transaction(async (tx) => { ... })  — a service owns the
#     atomicity boundary and passes `tx` INTO repos; the repos still do
#     the actual SQL. Forbidding this would force transactions into a
#     single repo, which is wrong (a transaction spans tables).
#
# EXEMPT: the db layer itself (schema / client / migrate / test-support
# / yjs-bootstrap) legitimately touches the driver; tests mock or stage
# queries freely. `connectivity-check.ts` is also exempt — its
# `sql`SELECT 1`` is a liveness ping (no table), not table data access.
#
# collab IS scanned: after the 2026-06-03 yjs two-DB cutover it HOSTS
# the `yjs_documents` repo (collab is the store's sole runtime owner).
# Its raw SQL lives in services/yjs-documents.repo.ts (auto-exempt as a
# *.repo.ts); persistence / auth / space-rpc / the lifecycle consumer
# route their access through that local repo, and the repo binds core's
# `yjsDb` (not the bare driver). The companion guard
# lint-no-yjs-documents-sql-outside-repo locks that table to its one
# repo; lint-no-postgres-outside-core keeps the driver out of collab.
#
# Runs in CI and as `pnpm lint:no-raw-sql-outside-repo`. Non-zero exit
# blocks the PR.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop (portable across BSD + GNU). `//` and `/* ... */` comments
# are stripped before grepping so a doc-comment showing example SQL
# won't false-positive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Raw postgres.js tagged template, or a Drizzle data query-builder.
# `db.transaction` is intentionally NOT matched (orchestration is allowed).
RAW_SQL_REGEX='(sql|rawPg)`|\bdb\.(select|insert|update|delete)\b'

SCAN_DIRS=(
  packages/core/src
  packages/server/src
  packages/domain/src
  packages/collab/src
)

CANDIDATES=$(find "${SCAN_DIRS[@]}" \
  -type f \
  -name '*.ts' \
  -not -name '*.repo.ts' \
  -not -name 'connectivity-check.ts' \
  -not -path '*/__tests__/*' \
  -not -path '*/db/*' \
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$RAW_SQL_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-raw-sql-outside-repo — raw DB access outside a *.repo.ts file:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Raw SQL (sql\`...\`) and Drizzle query builders (db.select /" >&2
  echo ".insert / .update / .delete) belong in a *.repo.ts file — one" >&2
  echo "table, one repo home. Move the query into" >&2
  echo "the owning repo and call it from here. (db.transaction for" >&2
  echo "service-level orchestration is allowed; it passes tx into repos.)" >&2
  exit 1
fi

echo "lint:no-raw-sql-outside-repo — clean (core + server + domain + collab keep raw SQL in *.repo.ts)"
