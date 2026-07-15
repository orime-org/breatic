#!/usr/bin/env bash
# no-inline-scrollbar guard — scrollbar styling has ONE owner: the global
# rules in packages/web/src/index.css (#1773, user-ratified 2026-07-15).
# Every scroller shows the NATIVE thin overlay scrollbar with pinned colors
# (`* { scrollbar-width: thin; scrollbar-color: ... }` + `color-scheme` on
# the theme roots): appears only while scrolling, no layout space, no hover
# shape change in either engine.
#
# Why component-level scrollbar styling is banned:
#   - ANY ::-webkit-scrollbar paint rule that took effect would force a
#     CLASSIC always-visible, space-consuming bar. (With the global standard
#     properties set it is dead code instead — CSS Scrollbars L1: a non-auto
#     standard property DISABLES webkit pseudo styling, real-engine probes
#     2026-07-14 — either way it must not exist.)
#   - scrollbar-width / scrollbar-color re-declarations fork the single
#     source of truth; the pinned scrollbar-color is also what suppresses
#     Chrome's hover widen-with-track (author-colored bars take Chrome's
#     simplified painter — round-3 A/B probe), so a re-declaration can
#     silently reintroduce the hover morph.
#
# Allowed (by design, not a loophole):
#   - scrollbar-width:none + [&::-webkit-scrollbar]:hidden — HIDING a
#     scrollbar entirely is a legitimate per-element layout decision
#     (SpaceTabBar). Both spellings of "hide" are needed: `none` hides in
#     engines implementing the standard property, the webkit `hidden` form
#     covers engines that don't (pre-18.2 Safari).
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

# webkit pseudo anywhere, or a standard scrollbar property EXCEPT width:none.
PAT='::-webkit-scrollbar|scrollbar-width:(thin|auto)|scrollbar-color'
# The one allowed webkit form (hide, not paint) — stripped from matched lines
# before the final violation test, so a line carrying ONLY the hide form
# passes while hide + paint on the same line still fails.
ALLOWED='\[&::-webkit-scrollbar\]:hidden'

# BSD-grep safe (find then grep), LC_ALL=C for stable byte-class matching.
HITS=$(find "$ROOT" \( -name '*.tsx' -o -name '*.ts' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/__tests__/*' -print0 \
  | LC_ALL=C xargs -0 grep -nE "$PAT" 2>/dev/null \
  | LC_ALL=C sed -E "s/${ALLOWED}//g" \
  | LC_ALL=C grep -E "$PAT" || true)

if [ -n "$HITS" ]; then
  echo "$HITS"
  echo ""
  echo "lint-no-inline-scrollbar: FAIL — scrollbar styling has one owner: the global rules in index.css (#1773)"
  echo "  fix: delete the inline scrollbar classes; every scroller gets the native thin overlay bar with pinned colors"
  echo "  hiding one entirely stays allowed via [scrollbar-width:none] (+ [&::-webkit-scrollbar]:hidden fallback)"
  exit 1
fi
echo "lint-no-inline-scrollbar: clean ✅ (native thin overlay scrollbars, one owner: index.css)"
