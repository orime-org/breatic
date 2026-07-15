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
# English. THIS file is scanned like any other — the matcher is written
# with \x{...} codepoint escapes, so it carries no raw CJK itself.
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
#   - Matching is done by PERL with \x{...} codepoint escapes, NOT by a
#     grep bracket range of raw CJK literals. GNU grep cannot match
#     multibyte bracket ranges in ANY locale (glibc defines no collating
#     elements for CJK: "Invalid collation character"), and BSD grep in
#     C/POSIX byte-matches them (false positives). The original grep
#     implementation therefore NEVER worked on CI — its error was
#     swallowed by `2>/dev/null || true` into a false CLEAN (exposed
#     2026-07-15 by the matcher self-test below). Perl's codepoint
#     semantics are locale-independent and identical on macOS + CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Forbidden character classes (Unicode blocks that commonly leak into
# source as comments / string literals / class names), as perl codepoint
# escapes (locale-independent; no raw CJK literals in this file):
#   U+3040-30FF  Hiragana + Katakana
#   U+4E00-9FFF  CJK Unified Ideographs
#   U+AC00-D7A3  Hangul Syllables
#   U+FF00-FFEF  Halfwidth and Fullwidth Forms
# (Same blocks the retired grep bracket range spanned — behaviour kept
# identical on purpose.)
CJK_PERL_CLASS='[\x{3040}-\x{30FF}\x{4E00}-\x{9FFF}\x{AC00}-\x{D7A3}\x{FF00}-\x{FFEF}]'

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
# their comments and echo strings must be English. This file scans itself
# too — the perl matcher uses codepoint escapes, no raw CJK (see above).
SH_FILES=$(find scripts \
  -type f -name '*.sh' \
  2>/dev/null || true)

# Matcher self-test — MUST run before the scan, because the scan suppresses
# stderr and "no match" would be indistinguishable from "matcher broken".
# History of silent breakage this guards against: the original grep bracket
# range never worked on CI at all (GNU grep: "Invalid collation character"
# in every locale — glibc has no CJK collating elements), and the error was
# swallowed into a false CLEAN for weeks. The perl matcher below is
# locale-independent, but the self-test stays: if perl/flags ever stop
# matching the positive sample (U+6587, bytes e6 96 87) or start matching
# the negative one (em dash U+2014 — catches accidental byte-mode
# regressions), refuse to scan. Samples are printf byte escapes,
# independent of this file's encoding.
if ! printf 'x\xe6\x96\x87x' | perl -CSD -ne "exit(/$CJK_PERL_CLASS/ ? 0 : 1)" 2>/dev/null \
  || printf 'x\xe2\x80\x94x' | perl -CSD -ne "exit(/$CJK_PERL_CLASS/ ? 0 : 1)" 2>/dev/null; then
  echo "lint:no-cjk — matcher self-test FAILED: perl codepoint matching is broken in this environment; refusing to scan (a clean result would be meaningless)" >&2
  exit 2
fi

# -CSD: treat input as UTF-8 so \x{...} classes see CODEPOINTS, not bytes.
# `close ARGV if eof` resets $. per file so line numbers are correct.
MATCHES=$(
  printf '%s\n%s\n%s\n' "$FILES" "$YAML_FILES" "$SH_FILES" \
    | grep -vE '^$' \
    | grep -vE "$ALLOWLIST_REGEX" \
    | tr '\n' '\0' \
    | xargs -0 perl -CSD -ne "print \"\$ARGV:\$.:\$_\" if /$CJK_PERL_CLASS/; close ARGV if eof" 2>/dev/null \
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
