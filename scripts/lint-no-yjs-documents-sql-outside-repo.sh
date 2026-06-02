#!/usr/bin/env bash
# lint-no-yjs-documents-sql-outside-repo — the `yjs_documents` table has
# exactly one repo home, enforced by name.
#
# Rationale (2026-06-02 ADR "DB adapter unification"): `yjs_documents` is
# shared infrastructure — collab persistence / auth / space-rpc AND the
# server project create / delete / duplicate cascade all touch it. The
# generic lint:no-raw-sql-outside-repo guard only proves SQL sits in SOME
# *.repo.ts; it does NOT prove a SHARED table has a SINGLE repo. That gap
# is exactly how this table's SQL scattered across two server repos
# (Drizzle) plus a hand-rolled collab postgres.js pool. This guard closes
# it: the `yjs_documents` table — by raw name `yjs_documents` or by its
# Drizzle symbol `yjsDocuments` — may be referenced only in its one repo
# home (and its schema definition).
#
# FORBIDDEN everywhere except the two allowed files: the raw table name
# `yjs_documents` or the Drizzle table symbol `yjsDocuments`.
#   - `yjsDocumentsRepo` (the namespace consumers import) does NOT match
#     — the `\b` after `yjsDocuments` fails against the trailing `Repo`.
#
# ALLOWED (the single home + the definition):
#   - packages/core/src/db/yjs-documents.repo.ts  (every query)
#   - packages/core/src/db/schema.ts              (the pgTable definition)
#
# EXEMPT: tests (*.test.ts / *.integration.test.ts / __tests__) stage /
# assert against the table freely; migrations are *.sql (not scanned).
#
# Runs in CI and as `pnpm lint:no-yjs-documents-sql-outside-repo`.
# Non-zero exit blocks the PR.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop (portable across BSD + GNU). `//` and `/* ... */` comments
# are stripped before grepping so a doc-comment naming the table won't
# false-positive (many files mention `yjs_documents` in prose).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The raw table name or the Drizzle table symbol. `\b` keeps the symbol
# match from firing on `yjsDocumentsRepo` (the consumer-facing namespace).
YJS_TABLE_REGEX='\byjs_documents\b|\byjsDocuments\b'

SCAN_DIRS=(
  packages/shared/src
  packages/core/src
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
  -not -path 'packages/core/src/db/yjs-documents.repo.ts' \
  -not -path 'packages/core/src/db/schema.ts' \
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$YJS_TABLE_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-yjs-documents-sql-outside-repo — yjs_documents referenced outside its single repo home:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "yjs_documents is a SHARED table with ONE repo home:" >&2
  echo "  packages/core/src/db/yjs-documents.repo.ts" >&2
  echo "Every read/write goes through yjsDocumentsRepo.* (call it from" >&2
  echo "your service / hook / route). Do not query the table — by raw" >&2
  echo "name or Drizzle symbol — anywhere else. (The schema definition in" >&2
  echo "core/db/schema.ts is the only other allowed reference.)" >&2
  exit 1
fi

echo "lint:no-yjs-documents-sql-outside-repo — clean (one table, one repo home)"
