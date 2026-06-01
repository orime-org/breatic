#!/usr/bin/env bash
# lint-no-trojan-source — block Trojan Source attacks (CVE-2021-42574):
# bidirectional-override (U+202A..U+202E / U+2066..U+2069) and invisible
# control characters that make the source a human reviewer sees differ from
# what the compiler / interpreter actually parses. A malicious contributor
# can hide a logic flip (e.g. an early return, a swapped comparison) inside
# a comment or string this way and pass human review.
#
# Rationale (CI maximal-strictness guard suite, inner ADR 2026-06-01): this
# is the modern, off-the-shelf consensus for a source character-set guard.
# It is the SECURITY half; the readability half (block CJK comments from
# creeping back as breatic goes global) is owned by the separate
# lint:no-cjk guard. The two do NOT overlap: this guard only flags the
# dangerous bidi / invisible code-hiding subset and never trips on ordinary
# non-ASCII text (CJK, accents, typography such as — → ≤ ✓, or emoji such
# as ⚠️ ✅ 🖼️ — emoji variation selectors are filtered out in the scanner,
# see scripts/check-trojan-source.mjs for why).
#
# Implementation: the actual detection is anti-trojan-source's public
# `hasConfusablesInFiles` API, invoked from scripts/check-trojan-source.mjs
# (NOT the package's bin/ CLI, which crashes on Node 24 — see that file's
# header). This wrapper only builds the file list and pipes it in.
#
# Runs in CI (.github/workflows/ci.yml) and as
# `pnpm lint:no-trojan-source`. Non-zero exit blocks merge.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Discover human-authored files via git (node_modules / dist are gitignored,
# so they are inherently excluded — no find-exclude gymnastics). Restrict to
# text source + config + docs; skip the generated lockfile and never touch
# any .env* template. Simple `grep -E` anchors are BSD/GNU portable (no
# char-class ranges / -P — those are the cross-platform traps).
FILES=$(git ls-files \
  | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|css|scss|html|sh|sql)$' \
  | grep -vE '(^|/)pnpm-lock\.yaml$' \
  | grep -vE '(^|/)\.env' \
  || true)

printf '%s\n' "$FILES" | node scripts/check-trojan-source.mjs
