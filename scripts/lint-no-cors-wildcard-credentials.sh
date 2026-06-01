#!/usr/bin/env bash
# lint-no-cors-wildcard-credentials — forbid a CORS config that pairs a
# wildcard origin ('*' / ['*']) with credentials: true.
#
# Rationale (CLAUDE.md 禁止清单 #5 + CI maximal-strictness guard suite,
# inner ADR 2026-06-01): `Access-Control-Allow-Origin: *` together with
# `Access-Control-Allow-Credentials: true` is a critical security
# misconfiguration. The browser will refuse the combination, but more
# importantly it signals intent to accept credentialed cross-origin
# requests from ANY origin — defeating same-origin protection for the
# session cookie. Allowed origins MUST be a specific whitelist (breatic
# reads it from env ALLOWED_ORIGINS). This guard fails the PR if any file
# sets BOTH a wildcard origin AND credentials: true.
#
# Detection is file-level: a file that configures `credentials: true`
# must not also contain a wildcard `origin: "*"` / `origin: ["*"]`.
# Comments are stripped first so a doc-comment example won't trip it.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:no-cors-wildcard-credentials`. Non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# A wildcard origin: origin: "*"  OR  origin: ["*"]  (optional whitespace).
WILDCARD_ORIGIN_REGEX="origin:[[:space:]]*\[?[[:space:]]*['\"]\*['\"]"
CREDENTIALS_REGEX="credentials:[[:space:]]*true"

CANDIDATES=$(find packages \
  -type f \
  \( -name '*.ts' -o -name '*.tsx' \) \
  -not -path '*/__tests__/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -name '*.test.ts' \
  -not -name '*.test.tsx' \
  -not -name '*.spec.ts' \
  2>/dev/null || true)

MATCHES=""
for file in $CANDIDATES; do
  # Strip // line + /* ... */ block comments before scanning, so a
  # doc-comment that mentions "*" + credentials doesn't false-positive.
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
  if printf '%s\n' "$cleaned" | grep -qE "$CREDENTIALS_REGEX" \
    && printf '%s\n' "$cleaned" | grep -qE "$WILDCARD_ORIGIN_REGEX"; then
    hit=$(printf '%s\n' "$cleaned" | grep -nE "$WILDCARD_ORIGIN_REGEX" | head -1)
    MATCHES+="${file}: wildcard origin + credentials:true (${hit})"$'\n'
  fi
done

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-cors-wildcard-credentials — wildcard origin paired with credentials:true:" >&2
  echo "" >&2
  printf '%s' "$MATCHES" >&2
  echo "" >&2
  echo "Per CLAUDE.md 禁止清单 #5, a CORS config must NOT pair a wildcard" >&2
  echo "origin (\"*\" / [\"*\"]) with credentials: true — it would accept" >&2
  echo "credentialed cross-origin requests from any origin. Use a specific" >&2
  echo "origin whitelist (breatic reads env ALLOWED_ORIGINS)." >&2
  exit 1
fi

echo "lint:no-cors-wildcard-credentials — clean (no wildcard origin + credentials)"
