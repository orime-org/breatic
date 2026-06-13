#!/usr/bin/env bash
# 1px-border guard — lock the rigid "all borders & focus rings are 1px solid,
# no glow" rule (DESIGN.md §5: focus 1px 实色无光晕; user 2026-06-12 拍 A 刚性
# 规范 + 2026-06-13 拍 A: 含头像叠层 border 也收 1px、守卫不留例外).
#
# Fails on, anywhere in packages/web/src (tests excluded):
#   - ring-offset*            — the focus-ring glow gap (forbidden; use no offset)
#   - ring-2 .. ring-9        — ring width ≥ 2px (1px focus ring = ring-1)
#   - border-2 .. border-9    — border width ≥ 2px (1px = border / border-1)
#   - directional border-{t,r,b,l,x,y}-[2-9] and arbitrary ring-[≥2px]/border-[≥2px]
#
# Vendor components/ui IS scanned — breatic's primitives are token-customised
# (status D / neutral ported), not pristine shadcn, so the visual rule applies.
#
# Exit: 0 clean · 1 violation · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-1px-border.sh                # packages/web/src
#   ./scripts/lint-1px-border.sh <dir>          # a fixture dir (tests)
#   pnpm lint:1px-border   (wired in package.json + CI)
set -euo pipefail

ROOT="${1:-packages/web/src}"
[ -d "$ROOT" ] || { echo "lint-1px-border: dir not found: $ROOT" >&2; exit 2; }

# Match the violating Tailwind utilities. A class boundary on the left is a
# start-of-string, whitespace, or quote (avoids matching e.g. "border" inside a
# longer word); on the right a non-digit / boundary (so ring-1 / border-1 pass).
PAT='ring-offset|(^|[^a-zA-Z0-9-])ring-[2-9]([^0-9]|$)|(^|[^a-zA-Z0-9-])border(-[trblxy])?-[2-9]([^0-9]|$)|ring-\[[2-9]|border-\[[2-9]'

# BSD-grep safe (memory reference_bsd_grep_exclude_order_trap): find then grep,
# LC_ALL=C to keep byte-class matching stable.
HITS=$(find "$ROOT" -name '*.tsx' -not -name '*.test.tsx' -not -path '*/__tests__/*' -print0 \
  | LC_ALL=C xargs -0 grep -nE "$PAT" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "$HITS"
  echo ""
  echo "lint-1px-border: FAIL — borders / focus rings must be 1px solid, no ring-offset glow"
  echo "  fix: ring-2 → ring-1 · remove ring-offset-* · border-2 → border (1px)"
  exit 1
fi
echo "lint-1px-border: clean ✅ (all borders + focus rings 1px, no glow)"
