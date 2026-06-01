#!/usr/bin/env bash
# lint-no-cjk — forbid CJK (and other non-Latin) characters in production
# source, including comments.
#
# Rationale (i18n migration, inner DD rev 3 + 2026-06-01 reaffirm):
# breatic is a global open-source project — contributors come from all
# over the world, so code AND comments must be written in English so any
# developer can read them. Separately, every user-facing string must live
# in `locales/*.json` and be routed through the shared `t()` helper.
# Hardcoded CJK in TS / TSX / CSS source — whether in a string literal OR
# a comment — is a regression and this guard fails the PR on it.
#
# Three categories are LEGITIMATELY non-English and are exempt:
#   1. i18n locale catalogs (`locales/*.json`) — product translations.
#      Not scanned (this guard only looks at .ts / .tsx / .css).
#   2. Test fixtures (`*.test.*`, `*.spec.*`, `__tests__/`) — Unicode /
#      locale-switching test logic legitimately uses CJK. Excluded below.
#   3. Deliberate product-data strings — e.g. the language switcher shows
#      each language in its own native script (简体中文 / 日本語), which by
#      design is never localized. These go in the ALLOWLIST below.
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
# written as raw UTF-8. This .sh file is not itself scanned by the guard.
CJK_REGEX='[぀-ヿ一-鿿가-힣＀-￯]'

# Allowlist — production files permitted to carry non-English by deliberate
# design (category 3 above). Keep this short and justify every entry in the
# PR that adds it.
#   - LangSwitcher.tsx: the language picker renders each language in its own
#     native script (简体中文 / 日本語 / 繁體中文); these are constant product
#     data, never localized. See memory feedback_language_picker_native_names.
ALLOWLIST_REGEX='packages/web/src/pages/project/chrome/top-bar/LangSwitcher\.tsx'

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

MATCHES=$(
  printf '%s\n' "$FILES" \
    | grep -vE "$ALLOWLIST_REGEX" \
    | tr '\n' '\0' \
    | xargs -0 grep -EnH "$CJK_REGEX" 2>/dev/null \
    || true
)

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-cjk — found non-English characters in production source:" >&2
  echo "" >&2
  echo "$MATCHES" >&2
  echo "" >&2
  echo "breatic is a global open-source project: code AND comments must be" >&2
  echo "written in English. User-facing strings must live in locales/*.json" >&2
  echo "and route through t(). If a match is a deliberate product-data" >&2
  echo "string (e.g. a language name shown in its native script), add the" >&2
  echo "file to the ALLOWLIST in scripts/lint-no-cjk.sh with a justification." >&2
  exit 1
fi

echo "lint:no-cjk — clean (no non-English characters in production source)"
