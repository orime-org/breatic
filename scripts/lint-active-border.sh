#!/usr/bin/env bash
# active-border guard — lock the "one neutral activation border" rule
# (user-ratified 2026-07-11): whenever a border colour EXPRESSES a
# selected / focused / active state in NEUTRAL (black/white/grey), it must be
# `border-active-border` (--color-active-border, the Input focus colour).
# Colour-semantic borders (border-status-*, palette) are a different system
# and are not constrained here.
#
# Fails on, anywhere in packages/web/src (tests + shadcn vendor excluded):
#   state-variant : neutral-border-class, i.e.
#     (focus|focus-within|focus-visible|aria-[current…]|aria-selected|
#      data-[state=checked]|data-[state=selected]|data-[state=on]|
#      data-[state=active]) :
#     border-(primary|secondary|accent|muted|muted-foreground|foreground|
#             input|ring|border|neutral-N|white|black)
#
# data-[state=active] (tab underlines) is IN scope — user ruled 2026-07-11
# that the active-tab underline joins the single neutral activation-border
# system (border-active-border), not a text-colour indicator exemption.
#
# Exemptions (by design, not loopholes):
#   - components/ui/ (shadcn vendor): ADR 14 keeps primitives untouched; a
#     checked checkbox/radio border is part of its FILL system (border+bg move
#     together), not an independent border indicator.
#   - Runtime-composed conditionals (selected ? 'border-…') are beyond a line
#     grep; the CLAUDE.md mandate covers them (this guard catches the
#     high-frequency variant-prefixed form).
#
# Exit: 0 clean · 1 violation · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-active-border.sh                # packages/web/src
#   ./scripts/lint-active-border.sh <dir>          # a fixture dir (tests)
#   pnpm lint:active-border   (wired in package.json + CI)
set -euo pipefail

ROOT="${1:-packages/web/src}"
[ -d "$ROOT" ] || { echo "lint-active-border: dir not found: $ROOT" >&2; exit 2; }

# State variants that make a border colour EXPRESS activation/selection,
# followed by a neutral border class. `border-active-border` itself never
# matches (not in the neutral list). Left boundary avoids partial words.
VARIANT='(focus|focus-within|focus-visible|aria-\[current[^]]*\]|aria-selected|data-\[state=(checked|selected|on|active)\])'
NEUTRAL='border-(primary|secondary|accent|muted|muted-foreground|foreground|input|ring|border|neutral-[0-9]+|white|black)'
PAT="${VARIANT}:${NEUTRAL}([^a-zA-Z-]|$)"

# BSD-grep safe (memory reference_bsd_grep_exclude_order_trap): find then grep,
# LC_ALL=C to keep byte-class matching stable. shadcn vendor excluded (ADR 14).
HITS=$(find "$ROOT" \( -name '*.tsx' -o -name '*.ts' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/__tests__/*' \
  -not -path '*/components/ui/*' -print0 \
  | LC_ALL=C xargs -0 grep -nE "$PAT" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "$HITS"
  echo ""
  echo "lint-active-border: FAIL — a NEUTRAL border expressing selection/activation must be border-active-border"
  echo "  fix: focus-visible:border-foreground → focus-visible:border-active-border (etc.)"
  echo "  colour-semantic borders (border-status-*) are a different system and stay as they are"
  exit 1
fi
echo "lint-active-border: clean ✅ (neutral activation borders all use border-active-border)"
