#!/usr/bin/env bash
# lint-no-drizzle-type-leak — forbid Drizzle's `$inferSelect` /
# `$inferInsert` row-type helpers outside the repository layer.
#
# Rationale (CLAUDE.md 禁止清单 #3 "Drizzle 类型泄漏" + CI maximal-
# strictness guard suite, inner ADR 2026-06-01): a Drizzle-inferred row
# type must NOT become the domain / service / API type. The repo layer
# (`*.repo.ts`) is the single place allowed to touch the inferred row
# type — and only to map it, via a `toEntity` function, to a hand-written
# domain entity (e.g. `NotificationEntity` / `CreditTransactionEntity` in
# @breatic/shared). Exporting `typeof table.$inferSelect` from the schema
# (or using it in a service signature) couples business logic + the HTTP
# response shape to the DB column layout — exactly the leak this forbids.
#
# HONEST SCOPE (PROXY, not a literal proof — see ADR §4): this catches the
# explicit `$inferSelect` / `$inferInsert` tokens used outside a
# `*.repo.ts`. It CANNOT detect an IMPLICIT leak (e.g. returning a bare
# `db.select()` result, whose type is still Drizzle-shaped, without ever
# writing `$inferSelect`). 禁#3 still needs human review for implicit
# Drizzle types reaching a service / route signature.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:no-drizzle-type-leak`. Non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LEAK_REGEX='\$infer(Select|Insert)\b'

# Everywhere EXCEPT *.repo.ts (the data-access layer, where the inferred
# row type is mapped to a hand-written entity) and tests.
CANDIDATES=$(find packages \
  -type f \
  \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.repo.ts' \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
  -not -name '*.test.tsx' \
  -not -name '*.spec.ts' \
  2>/dev/null || true)

MATCHES=""
for file in $CANDIDATES; do
  # Strip // line + /* ... */ block comments so a doc-comment that
  # mentions $inferSelect in prose doesn't false-positive.
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$LEAK_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-drizzle-type-leak — Drizzle \$inferSelect/\$inferInsert outside a *.repo.ts:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md 禁止清单 #3, a Drizzle-inferred row type must not" >&2
  echo "leak out of the repo layer. Keep \$inferSelect inside a *.repo.ts" >&2
  echo "toEntity() mapping and expose a hand-written domain entity (e.g." >&2
  echo "in @breatic/shared) to services / routes instead." >&2
  exit 1
fi

echo "lint:no-drizzle-type-leak — clean (\$inferSelect/\$inferInsert only inside *.repo.ts)"
