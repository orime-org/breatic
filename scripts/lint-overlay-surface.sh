#!/usr/bin/env bash
# lint:overlay-surface — every popover/overlay PANEL surface must be bg-popover.
#
# Spec: inner design/decisions/2026-06-12-overlay-surface-background.md (option A:
# one tier) + the 2026-06-13 dark-surface rework (popover dark #262626 / light
# #f5f5f5). All floating-overlay panel containers use bg-popover; tooltip is the
# only exception (bg-foreground inverse, so it is not in the scanned set).
#
# Rule (ported from sandbox token_test, eye-verified #1213): the overlay
# component files below must NOT use bg-elevated / bg-card as a panel surface
# (the historical drift: sheet=elevated, toast=card). bg-background is allowed
# (a CommandDialog wrapper / select trigger legitimately sits on the page), and
# menu-item hover fills (bg-muted / bg-accent) are not panel surfaces.
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

FILES="dialog alert-dialog sheet popover dropdown-menu context-menu select command sonner"

fail=0
for f in $FILES; do
  path="$ROOT/$f.tsx"
  [ -f "$path" ] || continue
  hits=$(LC_ALL=C grep -nE "bg-elevated|bg-card" "$path" || true)
  if [ -n "$hits" ]; then
    echo "FAIL $f.tsx — overlay panel surface must be bg-popover, not bg-elevated / bg-card:"
    echo "$hits" | sed 's/^/     /'
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "lint-overlay-surface: clean ✅ (all overlay panels use bg-popover; tooltip inverse is exempt)"
  exit 0
fi
echo ""
echo "lint-overlay-surface: FAIL — change the panel background to bg-popover"
exit 1
