#!/usr/bin/env bash
# no-inline-scrollbar guard — every visible scroller, vertical AND
# horizontal, goes through OUR Scroller component
# (components/ui/scroll-area.tsx; user-ratified 2026-07-15). The component
# owns the whole scrollbar behaviour contract: scroll-only visibility, no
# layout space, fade in/out, hover changes COLOR only, and scrollbar
# interaction never disturbs input state (focus/selection). Native
# scrollbars cannot deliver this — CSS Scrollbars L1 standardizes only
# thickness + two static colors; hover geometry/shading is UA-private and
# varies between browser builds. So this guard bans BOTH halves in
# packages/web/src ts/tsx (tests excluded):
#
#   1. Scrollbar style re-declarations:
#      - ANY ::-webkit-scrollbar paint rule (forces the classic scrollbar).
#      - scrollbar-width:thin / scrollbar-color (redundant with the global
#        index.css fallback; stacking a standard property with webkit rules
#        silently DISABLES the webkit styling per CSS Scrollbars L1 —
#        real-engine probes 2026-07-14 proved the pre-#1773 pattern shipped
#        dead rules and dropped Safari to an invisible black thumb in dark).
#   2. New NATIVE scrollers: overflow-auto / overflow-y-auto /
#      overflow-x-auto / overflow-scroll utility classes — a native
#      scroller shows the platform scrollbar and regresses the ratified
#      behaviour. Wrap the content in <ScrollArea> instead
#      (scrollbars='horizontal' / 'both' for horizontal axes).
#
# Allowed (by design, not a loophole):
#   - A scroller whose scrollbar is HIDDEN entirely: the line carries
#     [scrollbar-width:none] (+ [&::-webkit-scrollbar]:hidden fallback for
#     engines without the standard property). Hiding is a legitimate
#     per-element layout decision (SpaceTabBar).
#
# Exit: 0 clean · 1 violation · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-no-inline-scrollbar.sh                # packages/web/src
#   ./scripts/lint-no-inline-scrollbar.sh <dir>          # a fixture dir (tests)
#   pnpm lint:no-inline-scrollbar   (wired in package.json + CI)
set -euo pipefail

ROOT="${1:-packages/web/src}"
[ -d "$ROOT" ] || { echo "lint-no-inline-scrollbar: dir not found: $ROOT" >&2; exit 2; }

# webkit pseudo anywhere, a standard scrollbar property EXCEPT width:none,
# or a native-scroller overflow utility.
PAT='::-webkit-scrollbar|scrollbar-width:(thin|auto)|scrollbar-color|overflow-(auto|y-auto|x-auto|scroll)'
# Lines carrying the hidden-scrollbar marker are exempt in full (a scroller
# with a hidden bar shows no scrollbar, so overflow-* is fine there); the
# webkit hide form alone is stripped so hide + paint on one line still fails.
HIDDEN_MARKER='\[scrollbar-width:none\]'
ALLOWED='\[&::-webkit-scrollbar\]:hidden'

# BSD-grep safe (find then grep), LC_ALL=C for stable byte-class matching.
HITS=$(find "$ROOT" \( -name '*.tsx' -o -name '*.ts' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/__tests__/*' -print0 \
  | LC_ALL=C xargs -0 grep -nE "$PAT" 2>/dev/null \
  | LC_ALL=C grep -vE "$HIDDEN_MARKER" \
  | LC_ALL=C sed -E "s/${ALLOWED}//g" \
  | LC_ALL=C grep -E "$PAT" || true)

if [ -n "$HITS" ]; then
  echo "$HITS"
  echo ""
  echo "lint-no-inline-scrollbar: FAIL — visible scrollers must use the ScrollArea primitive (#1773: overlay bar, scroll-only, no layout space, hover = color only)"
  echo "  fix: wrap the scrolling content in <ScrollArea> (components/ui/scroll-area) instead of overflow-* / scrollbar styling"
  echo "  a scroller with a HIDDEN scrollbar stays allowed: keep [scrollbar-width:none] on the same line"
  exit 1
fi
echo "lint-no-inline-scrollbar: clean ✅ (all visible scrollers go through ScrollArea)"
