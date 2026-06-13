#!/usr/bin/env bash
# lint:overlay-surface — two-tier overlay surface rule.
#
# Rule: two-tier (decided 2026-06-13), superseding the earlier one-tier
# decision where every overlay panel used bg-popover. Floating overlays split
# into two families by behaviour:
#
#   CONTENT PANELS (takeover modal / side sheet — backdrop + multi-element body)
#     -> bg-card. Dialog / AlertDialog / Sheet. They read as a "screen in a box"
#     and match the auth-card / content-card surface.
#   ANCHORED FLOATS (popover / menu / picker attached to a trigger, no backdrop)
#     -> bg-popover. Popover / DropdownMenu / ContextMenu / Select / Command /
#     toast. Tooltip is inverse (bg-foreground) and exempt (not scanned).
#
# So: content panels must NOT use bg-popover / bg-elevated; anchored floats must
# NOT use bg-card / bg-elevated. bg-background is allowed (a CommandDialog
# wrapper / select trigger legitimately sits on the page); menu-item hover fills
# (bg-muted / bg-accent) are not panel surfaces.
#
# Exit: 0 clean · 1 violation · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-overlay-surface.sh                 # components/ui
#   ./scripts/lint-overlay-surface.sh <dir>           # a fixture dir (tests)
#   pnpm lint:overlay-surface   (wired in package.json + CI)
set -euo pipefail

ROOT="${1:-packages/web/src/components/ui}"
[ -d "$ROOT" ] || { echo "lint-overlay-surface: dir not found: $ROOT" >&2; exit 2; }

CONTENT_PANELS="dialog alert-dialog sheet"
ANCHORED_FLOATS="popover dropdown-menu context-menu select command sonner"

fail=0

# Content panels must be bg-card (not the anchored-float popover surface).
for f in $CONTENT_PANELS; do
  path="$ROOT/$f.tsx"
  [ -f "$path" ] || continue
  hits=$(LC_ALL=C grep -nE "bg-popover|bg-elevated" "$path" || true)
  if [ -n "$hits" ]; then
    echo "FAIL $f.tsx — content panel surface must be bg-card, not bg-popover / bg-elevated:"
    echo "$hits" | sed 's/^/     /'
    fail=1
  fi
done

# Anchored floats must be bg-popover (not the content-card surface).
for f in $ANCHORED_FLOATS; do
  path="$ROOT/$f.tsx"
  [ -f "$path" ] || continue
  hits=$(LC_ALL=C grep -nE "bg-card|bg-elevated" "$path" || true)
  if [ -n "$hits" ]; then
    echo "FAIL $f.tsx — anchored float surface must be bg-popover, not bg-card / bg-elevated:"
    echo "$hits" | sed 's/^/     /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "lint-overlay-surface: clean ✅ (content panels = bg-card, anchored floats = bg-popover)"
  exit 0
fi
echo ""
echo "lint-overlay-surface: FAIL — fix the panel surface per the two-tier rule"
exit 1
