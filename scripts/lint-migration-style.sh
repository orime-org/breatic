#!/usr/bin/env bash
# lint-migration-style — hand-written migrations must separate their statements
# and must name their foreign keys.
#
# Rationale (2026-07-28, #1840): every migration in this repo since 0018 is
# hand-written (drizzle-kit's snapshot is frozen at 0017, so `db:generate` would
# regenerate history wrongly). Hand-written means the two conventions drizzle
# used to emit are now the author's job, and #1839 shipped a migration that
# missed both.
#
# CHECK 1 — statement separation
#   Drizzle splits a migration file on `--> statement-breakpoint` and executes
#   each fragment separately (drizzle-orm/migrator.js). Without the marker the
#   whole file is sent as ONE `sql.raw()` call. That happens to work through
#   postgres.js's simple protocol, so a file missing it looks fine locally while
#   diverging from every other migration in the folder — and it stops working
#   the moment a statement needs to run outside the implicit batch.
#
# CHECK 2 — named foreign keys
#   `ADD COLUMN x uuid REFERENCES t(id)` lets PostgreSQL invent the constraint
#   name. Nobody can then drop or alter that constraint without first querying
#   the catalog to discover what it got called. Every other FK in this repo is
#   explicitly named `<table>_<column>_<target>_<target_col>_fk`.
#
# COUNTING STATEMENTS CORRECTLY (learned the hard way)
#   The first version of this check counted every `;` in the file. Migration
#   headers in this repo are long prose comments, and prose contains semicolons
#   ("the subsystem was removed; this migration drops its artifact"). That
#   version reported three historical migrations as violations when each in fact
#   holds a single statement — and nearly caused three untouchable files to be
#   rewritten. Only semicolons on NON-COMMENT lines are statements.
#
# SCOPE
#   packages/core/src/db/migrations/*.sql and migrations-yjs/*.sql.
#   No exemptions: a file with one statement needs no separator and passes; a
#   file with two or more must have one.
#
# Runs in CI (.github/workflows/ci.yml) and as `pnpm lint:migration-style`.
# A non-zero exit blocks merge. Pass --self-test to verify the checker itself.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MIGRATION_GLOBS=(
  "packages/core/src/db/migrations"
  "packages/core/src/db/migrations-yjs"
)

# Count SQL statements in a file: semicolons on lines that are not SQL comments.
# $1 = file path
count_statements() {
  grep -v '^[[:space:]]*--' "$1" | grep -o ';' | wc -l | tr -d ' '
}

# Print one line per violation, or nothing when the tree is clean.
find_offenders() {
  local dir f stmts
  for dir in "${MIGRATION_GLOBS[@]}"; do
    [ -d "$dir" ] || continue
    for f in "$dir"/*.sql; do
      [ -f "$f" ] || continue

      stmts=$(count_statements "$f")
      if [ "$stmts" -gt 1 ] && ! grep -q -- '--> statement-breakpoint' "$f"; then
        printf '%s: %s statements but no `--> statement-breakpoint`\n' "$f" "$stmts"
      fi

      # An unnamed FK: REFERENCES appears on a non-comment line, and the file
      # never names a constraint.
      if grep -v '^[[:space:]]*--' "$f" | grep -qi 'REFERENCES' \
         && ! grep -v '^[[:space:]]*--' "$f" | grep -qi 'CONSTRAINT'; then
        printf '%s: foreign key without an explicit CONSTRAINT name\n' "$f"
      fi
    done
  done
}

if [[ "${1:-}" == "--self-test" ]]; then
  echo "self-test 1/3: clean tree must PASS"
  if [ -n "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: the tree already has offenders:"
    find_offenders | sed 's/^/  /'
    exit 1
  fi
  echo "  ok"

  probe="packages/core/src/db/migrations/9999__probe.sql"

  echo "self-test 2/3: two statements without a separator must FAIL"
  cat > "$probe" <<'PROBE'
-- probe: prose with a semicolon; it must not be counted as a statement.
ALTER TABLE "a" ADD COLUMN "x" text;
ALTER TABLE "a" ADD COLUMN "y" text;
PROBE
  if [ -z "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: a separator-less multi-statement file did not trip the checker."
    rm -f "$probe"; exit 1
  fi
  echo "  ok"

  echo "self-test 3/3: one statement plus prose semicolons must PASS"
  cat > "$probe" <<'PROBE'
-- probe: the subsystem was removed; this migration drops its only artifact.
-- Another sentence; with another semicolon; and one more.
ALTER TABLE "a" ADD COLUMN "x" text;
PROBE
  if [ -n "$(find_offenders)" ]; then
    echo "SELF-TEST FAILED: prose semicolons were miscounted as statements:"
    find_offenders | sed 's/^/  /'
    rm -f "$probe"; exit 1
  fi
  echo "  ok"

  rm -f "$probe"
  echo "self-test passed"
  exit 0
fi

offenders="$(find_offenders)"
if [ -z "$offenders" ]; then
  echo "OK: migrations separate their statements and name their foreign keys."
  exit 0
fi

echo "FAIL: migration style violations:"
printf '%s\n' "$offenders" | sed 's/^/  /'
cat <<'MSG'

  Multiple statements -> put `--> statement-breakpoint` between them, so drizzle
  executes each one separately instead of sending the file as a single raw call.

  Foreign key -> name it explicitly:
    ADD CONSTRAINT "<table>_<column>_<target>_<target_col>_fk"
      FOREIGN KEY ("<column>") REFERENCES "public"."<target>"("<target_col>")
      ON DELETE <action> ON UPDATE no action;
MSG
exit 1
