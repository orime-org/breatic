#!/usr/bin/env bash
# Raw-design-value guard — fail CI / pre-commit if a component hardcodes a
# design value instead of consuming a token. This is the anti-DRIFT gate for
# the design-system migration (9th rebuild): once the codebase is on tokens,
# this keeps it there — any regression to raw px / raw color / raw radius is
# blocked at CI.
#
# Five checks (all scan packages/web/src/**/*.{ts,tsx}):
#   1. text-[Npx]      raw font size      → use text-{2xs..4xl} tokens
#   2. [var(--neutral  raw neutral PRIMITIVE → use a semantic token
#                      (bg-muted / text-foreground / border-border / …)
#   3. rounded-[Npx]   raw radius         → use rounded-chrome / rounded-content-*
#   4. #RRGGBB         raw hex color      → use a semantic / status token
#   5. (h|w|size|…)-[24|28|32|44px]  raw BUTTON-LADDER size → use a --btn-* token
#                      (h-[var(--btn-default)]=32, --btn-inline=28, --btn-compact
#                      =24, --btn-cta=44). ONLY the four ladder values are banned;
#                      every other px size is one-off layout and passes.
#
# NOT flagged (these are correct, not drift):
#   - [var(--<final-token>)] e.g. h-[var(--btn-chrome)], z-[var(--z-popover)],
#     rounded-[var(--radius-content-sm)] — consuming a final token via var() is
#     the supported way to use custom-scale tokens that have no utility class.
#   - non-ladder geometry px (w-[420px] / h-[30px] / gap-[7px] / size-[18px]) —
#     one-off layout sizes / icon px, NOT the button ladder.
#
# Exemptions (per check):
#   - theme/tokens.css                 the token DEFINITION source (hex/neutral)
#   - ui/BrandMark.tsx                 logo SVG — the only place brand hex lives
#   - spaces/canvas/inpaint/** + InpaintCanvas.tsx + mask-export.ts
#                                      functional brush/canvas ink, not UI tokens
#   - *.test.* / __tests__/            tests may assert raw class strings
#   - per-line escape: a line containing "design-value: allow"
#
# Exit code: 0 clean · 1 violation(s) · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-no-raw-design-values.sh          scans packages/web/src
#   ./scripts/lint-no-raw-design-values.sh <dir>    scans <dir> (tests)
#   pnpm lint:no-raw-design-values   (wired in package.json + CI)
set -euo pipefail
export LC_ALL=C

WEB_SRC="${1:-packages/web/src}"

if [ ! -d "$WEB_SRC" ]; then
  echo "lint-no-raw-design-values: $WEB_SRC not found (run from repo root)" >&2
  exit 2
fi

# Shared path-based exemption filter applied to every check's raw matches.
# (We post-filter rather than rely on grep --exclude after --include — BSD grep
# ignores that order; see memory reference_bsd_grep_exclude_order_trap.)
filter_common() {
  grep -v '^[[:space:]]*$' \
    | grep -v '\.test\.' \
    | grep -v '/__tests__/' \
    | grep -v 'design-value: allow' \
    || true
}

FAIL=0
report() {
  # $1 = human label, $2 = matches (possibly empty)
  if [ -n "$2" ]; then
    FAIL=1
    echo "lint-no-raw-design-values: ❌ $1" >&2
    echo "$2" >&2
    echo "" >&2
  fi
}

# 1. Raw font size: text-[13px] / text-[10.5px] → text-* token
M_TEXT=$(grep -Ern --include='*.ts' --include='*.tsx' 'text-\[[0-9.]+px\]' "$WEB_SRC" 2>/dev/null \
  | filter_common || true)
report "raw font size — use text-{2xs..4xl} tokens, not text-[Npx]:" "$M_TEXT"

# 2. Raw neutral primitive: [var(--neutral-N)] → semantic token
M_NEUTRAL=$(grep -Ern --include='*.ts' --include='*.tsx' '\[var\(--neutral' "$WEB_SRC" 2>/dev/null \
  | filter_common || true)
report "raw neutral primitive — use a semantic token (bg-muted / text-foreground / border-border …), not [var(--neutral-N)]:" "$M_NEUTRAL"

# 3. Raw radius: rounded-[6px] → rounded-chrome / rounded-content-*
M_RADIUS=$(grep -Ern --include='*.ts' --include='*.tsx' 'rounded-\[[0-9]+px\]' "$WEB_SRC" 2>/dev/null \
  | filter_common || true)
report "raw radius — use rounded-chrome / rounded-content-*, not rounded-[Npx]:" "$M_RADIUS"

# 4. Raw hex color → semantic / status token. Exempt the logo + inpaint ink +
#    the token definition file (which legitimately holds hex).
M_HEX=$(grep -Ern --include='*.ts' --include='*.tsx' '#[0-9a-fA-F]{6}\b' "$WEB_SRC" 2>/dev/null \
  | filter_common \
  | grep -v "$WEB_SRC/theme/tokens.css:" \
  | grep -v "$WEB_SRC/ui/BrandMark.tsx:" \
  | grep -v 'inpaint' \
  || true)
report "raw hex color — use a semantic / status token, not #RRGGBB (logo + inpaint ink are exempt):" "$M_HEX"

# 5. Raw button-ladder size: a height/width/size hardcoded to a ladder value
#    (24/28/32/44) → must go through a --btn-* token. Other px sizes pass.
M_LADDER=$(grep -Ern --include='*.ts' --include='*.tsx' '\b(h|w|size|min-h|min-w|max-h|max-w)-\[(24|28|32|44)px\]' "$WEB_SRC" 2>/dev/null \
  | filter_common || true)
report "raw button-ladder size — use a --btn-* token (h-[var(--btn-default)]=32, etc.), not h/w/size-[24|28|32|44px]:" "$M_LADDER"

if [ "$FAIL" -eq 0 ]; then
  echo "lint-no-raw-design-values: clean ✅ (no raw design values in $WEB_SRC)"
  exit 0
fi

echo "Rule: design-system 9th rebuild — components consume tokens, never raw px/color/radius." >&2
echo "Correct token consumption like h-[var(--btn-chrome)] / rounded-[var(--radius-content-sm)] is allowed." >&2
echo "Escape one intentional line: append a 'design-value: allow' comment." >&2
exit 1
