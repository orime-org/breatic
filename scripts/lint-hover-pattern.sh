#!/usr/bin/env bash
# Hover pattern lint — fail CI / pre-commit if any Tailwind alpha-modifier
# `hover:bg-<token>/<2-digit>` appears in `packages/web/src/`.
#
# Why: see inner ADR `design/decisions/2026-05-21-hover-pattern-standard.md`.
# Mock chrome-baseline uses solid token swaps + opacity-90 for hover;
# alpha-modifier covers (the shadcn vendor default) blend with the
# underlying surface and give weak / surface-dependent contrast.
#
# Exit code:
#   0 — no violations
#   1 — at least one violation; prints file:line:matched-class
#
# Usage:
#   ./scripts/lint-hover-pattern.sh
#   pnpm lint:hover     (if wired in package.json)

set -euo pipefail

WEB_SRC="packages/web/src"
PATTERN='hover:bg-[a-z][a-z0-9-]*\/[0-9]{2}'

if [ ! -d "$WEB_SRC" ]; then
  echo "lint-hover-pattern: $WEB_SRC not found (run from repo root)" >&2
  exit 2
fi

MATCHES=$(grep -Ern --include='*.ts' --include='*.tsx' "$PATTERN" "$WEB_SRC" || true)

if [ -z "$MATCHES" ]; then
  echo "lint-hover-pattern: clean ✅ (no banned hover:bg-X/NN patterns in $WEB_SRC)"
  exit 0
fi

echo "lint-hover-pattern: ❌ FAIL — banned hover:bg-<token>/<2-digit> pattern found:" >&2
echo "" >&2
echo "$MATCHES" >&2
echo "" >&2
echo "See: design/decisions/2026-05-21-hover-pattern-standard.md (in breatic-inner-design)" >&2
echo "Fix: use solid token swap (hover:bg-accent) or transition-opacity hover:opacity-90." >&2
exit 1
