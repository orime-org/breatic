#!/usr/bin/env bash
# lint-schema-timestamps — every Drizzle pgTable must carry created_at
# and deleted_at, with a small justified allowlist for deleted_at.
#
# Rationale (CLAUDE.md 软删除 + created_at mandates + CI maximal-
# strictness guard suite, inner ADR 2026-06-01):
#   - created_at (REQUIRED on every table, no exemption): every PG table
#     must have `created_at timestamptz DEFAULT now() NOT NULL` — via the
#     `timestamps` helper (created_at + updated_at) for business tables,
#     or a standalone created_at for append-only tables.
#   - deleted_at (REQUIRED, with a justified allowlist): all tables soft-
#     delete via `deleted_at`; list queries filter `deleted_at IS NULL`.
#
# DELETED_AT ALLOWLIST (each exemption justified, NOT a back door):
#   - payments              append-only financial record (Stripe). A
#                           payment is never soft-deleted — accounting /
#                           audit integrity. CLAUDE.md "append-only 历史/
#                           事件表只用 created_at" carve-out.
#   - credit_transactions   append-only credit ledger (immutable
#                           accounting). Same carve-out.
#   - credit_balances       1:1 with users (PK = user_id); its soft-delete
#                           is DERIVED from users.deleted_at via the inner
#                           join in credit.repo.ts (getBalance /
#                           deductBalance / addBalance). An own deleted_at
#                           would be a redundant second source of truth.
# created_at has NO allowlist — every table must have it.
#
# Implementation: parse each `export const <name> = pgTable(` block and
# check, within the block, for `...timestamps` / `created_at` and for
# `deleted_at`. A table missing created_at fails; a table missing
# deleted_at fails unless its name is in the allowlist above.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:schema-timestamps`. Non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Files that define Drizzle tables (today only the core schema; scan any
# non-test .ts containing pgTable so a future split is still covered).
SCHEMA_FILES=$(grep -rlE 'pgTable\(' packages --include='*.ts' 2>/dev/null \
  | grep -vE '__tests__|\.test\.|/node_modules/|/dist/' || true)

VIOLATIONS=$(
  for file in $SCHEMA_FILES; do
    awk -v FILE="$file" '
      # deleted_at allowlist (drizzle const names) — justified in header.
      BEGIN {
        allow["payments"] = 1
        allow["creditTransactions"] = 1
        allow["creditBalances"] = 1
      }
      function evaluate() {
        if (curname == "") return
        if (!has_created)
          print FILE ": table \"" curname "\" is missing created_at (use the timestamps helper or a created_at column)"
        if (!has_deleted && !(curname in allow))
          print FILE ": table \"" curname "\" is missing deleted_at (soft-delete mandate; add a justified entry to the allowlist in lint-schema-timestamps.sh if genuinely exempt)"
      }
      /=[[:space:]]*pgTable\(/ {
        evaluate()
        name = $0
        sub(/[[:space:]]*=.*/, "", name)        # "export const payments"
        nf = split(name, parts, /[[:space:]]+/) # last token is the var name
        name = parts[nf]
        gsub(/[^A-Za-z0-9_]/, "", name)         # safety strip
        curname = name; has_created = 0; has_deleted = 0
        next
      }
      /\.\.\.timestamps|created_at|createdAt/ { has_created = 1 }
      /deleted_at|deletedAt/ { has_deleted = 1 }
      END { evaluate() }
    ' "$file"
  done
)

if [[ -n "$VIOLATIONS" ]]; then
  echo "lint:schema-timestamps — table(s) missing required timestamp columns:" >&2
  echo "" >&2
  printf '%s\n' "$VIOLATIONS" >&2
  echo "" >&2
  echo "Every PG table needs created_at (no exemption) and deleted_at" >&2
  echo "(soft-delete mandate; a few append-only / user-derived financial" >&2
  echo "tables are allowlisted with justification in the script)." >&2
  exit 1
fi

echo "lint:schema-timestamps — clean (every table has created_at + deleted_at, allowlist justified)"
