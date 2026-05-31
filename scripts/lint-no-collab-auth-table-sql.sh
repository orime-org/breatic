#!/usr/bin/env bash
# lint-no-collab-auth-table-sql — forbid @breatic/collab from
# hand-rolling the shared authentication lookups.
#
# Rationale (2026-05-31 ADR "二次调整" 鉴权统一): collab used to
# hand-roll its own auth — a raw `redis.get(`${env}:session:${token}`)`
# for the session and raw SQL `SELECT ... FROM project_members JOIN
# users` for the role — which drifted from the API server's path. PR2
# moved both into @breatic/core (`getSession` + `loadProjectRole`) so
# auth is identical across every backend service. This guard locks
# that in: collab must NEVER re-introduce either lookup directly.
#
# FORBIDDEN in collab source:
#   - `project_members`  — the role table; its appearance means a
#     hand-rolled role query. collab must call core `loadProjectRole`.
#   - `:session:`        — the raw session-key literal; its appearance
#     means a hand-rolled session lookup. collab must call core
#     `getSession` (which owns the `{env}:session:{token}` key).
#
# collab's remaining raw SQL is against its own `yjs_documents` table
# (persistence + space-existence) — that is collab-private and NOT
# covered here; consolidating it into one repo is the collab internal
# reorg (a separate PR).
#
# Runs in CI and as `pnpm lint:no-collab-auth-table-sql`. Non-zero exit
# blocks the PR.
#
# Implementation note: BSD grep on macOS treats `--exclude` after
# `--include` as a no-op, so file filtering uses `find` + a per-file
# scan loop (portable across BSD + GNU). `//` and `/* ... */` comments
# are stripped before grepping so a doc-comment that mentions
# `project_members` (e.g. members-sync's explanation) won't
# false-positive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The two drift signatures: the role table name, or the raw session-key
# literal. `getSession` / `SESSION_COOKIE_NAME` (the core helpers collab
# is SUPPOSED to use) do not contain the `:session:` colon-delimited
# form, so they never false-positive.
AUTH_DRIFT_REGEX='project_members|:session:'

SCAN_DIRS=(
  packages/collab/src
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
  hits=$(printf '%s\n' "$cleaned" | grep -nE "$AUTH_DRIFT_REGEX" || true)
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      MATCHES+="${file}:${line}"$'\n'
    done <<< "$hits"
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-collab-auth-table-sql — collab hand-rolls a shared auth lookup:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "@breatic/collab must NOT query project_members or build a" >&2
  echo "raw :session: redis key. Session + role resolution live in" >&2
  echo "@breatic/core — call getSession / projectAuthService.loadProjectRole" >&2
  echo "so collab + server can never drift on auth. See ADR 二次调整" >&2
  echo "鉴权统一 + packages/collab/src/auth.ts." >&2
  exit 1
fi

echo "lint:no-collab-auth-table-sql — clean (collab routes auth through core)"
