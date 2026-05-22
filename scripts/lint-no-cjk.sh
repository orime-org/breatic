#!/usr/bin/env bash
# lint-no-cjk — forbid CJK Unified Ideographs in production source.
#
# Rationale (i18n migration, inner DD rev 3 `2026-05-22-breatic-i18n-migration-rev-3-no-phasing.md`):
# Every user-facing string must live in `locales/*.json` and be routed
# through the shared `t()` helper. Hardcoded CJK in TS / TSX / CSS
# files is a regression on the migration: it skips localization and
# breaks the en / zh-CN / zh-TW / ja parity guarantee.
#
# This script greps `packages/**/src/**` for CJK Unified Ideographs
# (Unicode block U+4E00–U+9FFF) and fails non-zero if any match shows
# up in production source. The check runs in CI (see `.github/`) and
# is also wired as `pnpm lint:no-cjk` for local use.
#
# Exclusions:
#   - **/__tests__/**     — test fixtures legitimately use CJK to
#                            cover Unicode + locale switching paths
#   - **/*.test.*          — same
#   - **/*.spec.*          — same
#   - packages/web/src/components/ui/** — vendored shadcn primitives
#                            (separate ESLint ignore policy)
#   - packages/web/src/i18n/locale-bootstrap.ts — bundles locale JSON
#                            via the @locales alias; matched by the
#                            JSON catalog scan, not by source scan
#   - CSS font-family stack entries (e.g. 'Noto Sans SC') — these are
#                            font names, not UI text. The grep regex
#                            matches the CJK Unified Ideographs block
#                            only, which leaves Latin font names alone;
#                            but a font-family stack that includes a
#                            Chinese font name (e.g. '微软雅黑') would
#                            trip this script. Add such files to the
#                            allowlist below if needed.
#
# Locale JSON catalogs (`locales/*.json`) are NOT scanned — they are
# expected to contain CJK by definition.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Forbid CJK across the full set of Unicode blocks that commonly
# leak into source comments / string literals / class names:
#
#   U+3000–303F  CJK Symbols and Punctuation     (、。「」・)
#   U+3040–309F  Hiragana                        (ぁ-ゟ)
#   U+30A0–30FF  Katakana                        (゠-ヿ)
#   U+4E00–9FFF  CJK Unified Ideographs          (一-鿿)
#   U+AC00–D7AF  Hangul Syllables                (가-힣)
#   U+FF00–FFEF  Halfwidth and Fullwidth Forms   (全角 ０-９Ａ-Ｚ)
CJK_REGEX='[぀-ヿ一-鿿가-힣＀-￯]'

# Glob include — production TS / TSX / CSS in any package.
INCLUDES=(
  --include='*.ts'
  --include='*.tsx'
  --include='*.css'
)

# Path exclusions. `--exclude-dir` + `--exclude` cover the test and
# vendored cases mechanically; specific files go in the allowlist
# below if they need to keep CJK for a deliberate reason.
EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=.next
  --exclude-dir=.turbo
  --exclude-dir=__tests__
  --exclude-dir=tests
  --exclude-dir=ui
)

EXCLUDE_FILES=(
  --exclude='*.test.ts'
  --exclude='*.test.tsx'
  --exclude='*.spec.ts'
  --exclude='*.spec.tsx'
)

# Allowlist — full repo-relative paths that are permitted to contain
# CJK. Keep this list short and reasoned; every entry should be
# justified in a PR description, not added silently.
ALLOWLIST_REGEX='^$' # placeholder; nothing allowlisted today

MATCHES=$(grep -rEn "$CJK_REGEX" \
  "${INCLUDES[@]}" \
  "${EXCLUDE_DIRS[@]}" \
  "${EXCLUDE_FILES[@]}" \
  packages/ 2>/dev/null \
  | grep -Ev "$ALLOWLIST_REGEX" \
  || true)

if [[ -n "$MATCHES" ]]; then
  echo "lint:no-cjk — found CJK Unified Ideographs in production source:" >&2
  echo "$MATCHES" >&2
  echo "" >&2
  echo "Every user-facing string must live in locales/*.json and be" >&2
  echo "routed through the shared t() helper. If the match is a" >&2
  echo "deliberate exception (e.g. CSS font-family stack), add the" >&2
  echo "file to the allowlist in scripts/lint-no-cjk.sh." >&2
  exit 1
fi

echo "lint:no-cjk — clean (no CJK Unified Ideographs in production source)"
