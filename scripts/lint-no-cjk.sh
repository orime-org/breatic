#!/usr/bin/env bash
# lint-no-cjk — forbid CJK (and other non-Latin) characters in production
# source AND YAML config, including comments.
#
# Rationale (i18n migration, inner DD rev 3 + 2026-06-01 reaffirm):
# breatic is a global open-source project — contributors come from all
# over the world, so code AND comments must be written in English so any
# developer can read them. Separately, every user-facing string must live
# in `locales/*.json` and be routed through the shared `t()` helper.
# Hardcoded CJK in TS / TSX / CSS source — whether in a string literal OR
# a comment — is a regression and this guard fails the PR on it.
#
# YAML config is scanned too (CLAUDE.md prohibition #13, "no CJK in YAML"):
# config/*.yaml, docker-compose.yml, the workspace file and the GitHub
# workflow yaml are operational artifacts developers read and run, so
# their comments and values must be English just like source. The
# generated pnpm-lock.yaml is excluded (machine-authored, not edited).
#
# Shell guard scripts are scanned too (scripts/*.sh): they are code that
# developers read and run, so their comments and echo strings must be
# English. The sole exception is THIS file — a CJK detector necessarily
# embeds the CJK range characters in its matcher (CJK_REGEX below), so it
# cannot scan itself; its prose is kept English by review.
#
# Three categories are LEGITIMATELY non-English and are exempt:
#   1. i18n locale catalogs (`locales/*.json`) — product translations.
#      Not scanned (this guard looks at .ts / .tsx / .css / .yaml / .yml
#      and scripts/*.sh).
#   2. Test fixtures (`*.test.*`, `*.spec.*`, `__tests__/`) — Unicode /
#      locale-switching test logic legitimately uses CJK. Excluded below.
#   3. Deliberate product-data strings — e.g. the language switcher shows
#      each language in its own native script (Simplified Chinese,
#      Japanese, ...), which by design is never localized. These go in the
#      ALLOWLIST below.
#
# Implementation notes (this guard used to be silently broken):
#   - The file list is built with `find`, NOT grep's --include/--exclude.
#     BSD grep (macOS) treats --exclude placed after --include as a no-op,
#     so the old script scanned test files locally while excluding them in
#     CI — inconsistent and surprising.
#   - LC_ALL is forced to a real UTF-8 locale before grepping. The CJK
#     character class is multibyte and its matching is locale-dependent:
#     under a C / POSIX locale the class silently fails to match (the CI
#     false-green that let CJK comments accumulate), while under macOS's
#     UTF-8 default it matches. Pinning a UTF-8 locale makes the result
#     deterministic on every machine.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Force a real UTF-8 locale so the multibyte character class below matches
# deterministically. ubuntu CI ships C.UTF-8; macOS ships en_US.UTF-8 —
# pick whichever exists first.
for _loc in C.UTF-8 en_US.UTF-8 en_US.utf8 C.utf8; do
  if locale -a 2>/dev/null | grep -qix "$_loc"; then
    export LC_ALL="$_loc"
    break
  fi
done

# Forbidden character classes (Unicode blocks that commonly leak into
# source as comments / string literals / class names):
#   U+3000-303F  CJK Symbols and Punctuation
#   U+3040-309F  Hiragana
#   U+30A0-30FF  Katakana
#   U+4E00-9FFF  CJK Unified Ideographs
#   U+AC00-D7AF  Hangul Syllables
#   U+FF00-FFEF  Halfwidth and Fullwidth Forms
# NOTE: the literal range characters below are unavoidable (the regex has
# to span the blocks) and bash 3.2 on macOS lacks `$'\uXXXX'`, so they are
# written as raw UTF-8. This is exactly why this file excludes itself from
# the scripts/*.sh scan (it necessarily contains CJK in CJK_REGEX).
CJK_REGEX='[぀-ヿ一-鿿가-힣＀-￯]'

# Allowlist — production files permitted to carry non-English by deliberate
# design (category 3 above). Keep this short and justify every entry in the
# PR that adds it.
#   - features/preferences/supported-langs.ts: the shared locale list (used
#     by both the project and studio language switchers) renders each
#     language in its own native script (Simplified Chinese, Japanese,
#     Traditional Chinese, Korean); these are constant product data, never
#     localized.
ALLOWLIST_REGEX='packages/web/src/features/preferences/supported-langs\.ts'

# Build the scan list with find (portable across BSD + GNU; avoids the
# grep --include/--exclude ordering trap). Production TS / TSX / CSS only,
# minus vendored / generated / test paths.
FILES=$(find packages \
  -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/.next/*' \
  -not -path '*/.turbo/*' \
  -not -path '*/__tests__/*' \
  -not -path '*/tests/*' \
  -not -path '*/web/src/components/ui/*' \
  -not -name '*.test.ts' \
  -not -name '*.test.tsx' \
  -not -name '*.spec.ts' \
  -not -name '*.spec.tsx' \
  2>/dev/null || true)

# YAML config (prohibition #13): runtime config (config/**), the workspace
# + compose files, and the GitHub workflow yaml. pnpm-lock.yaml is
# generated (machine-authored) and excluded.
YAML_FILES=$(find config .github docker-compose.yml pnpm-workspace.yaml \
  -type f \( -name '*.yaml' -o -name '*.yml' \) \
  -not -path '*/node_modules/*' \
  -not -name 'pnpm-lock.yaml' \
  2>/dev/null || true)

# Shell guard scripts (scripts/*.sh): code developers read and run, so
# their comments and echo strings must be English. lint-no-cjk.sh excludes
# itself — a CJK detector necessarily embeds CJK in its matcher (see above).
SH_FILES=$(find scripts \
  -type f -name '*.sh' \
  -not -name 'lint-no-cjk.sh' \
  2>/dev/null || true)

MATCHES=$(
  printf '%s\n%s\n%s\n' "$FILES" "$YAML_FILES" "$SH_FILES" \
    | grep -vE '^$' \
    | grep -vE "$ALLOWLIST_REGEX" \
    | tr '\n' '\0' \
    | xargs -0 grep -EnH "$CJK_REGEX" 2>/dev/null \
    || true
)

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-cjk — found non-English characters in production source, YAML config or shell scripts:" >&2
  echo "" >&2
  echo "$MATCHES" >&2
  echo "" >&2
  echo "breatic is a global open-source project: code, comments, YAML" >&2
  echo "config and shell scripts (prohibition #13) must be in English." >&2
  echo "User-facing strings must live in locales/*.json and route through" >&2
  echo "t(). If a match is a deliberate product-data string (e.g. a language" >&2
  echo "name shown in its native script), add the file to the ALLOWLIST in" >&2
  echo "scripts/lint-no-cjk.sh with a justification." >&2
  exit 1
fi

echo "lint:no-cjk — clean (no non-English characters in production source, YAML config or shell scripts)"
