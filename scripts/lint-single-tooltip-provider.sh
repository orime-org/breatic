#!/usr/bin/env bash
# single-tooltip-provider guard — the app mounts exactly ONE
# <TooltipProvider> (App.tsx). Its delayDuration is the calibrated timing
# every tooltip in the app shares, and Radix's skip-delay grouping (a tooltip
# opening INSTANTLY when the pointer sweeps from one trigger to the next)
# works only WITHIN a single provider instance. A component that nests its
# own <TooltipProvider> overrides that timing for its subtree AND splits it
# into its own skip-delay group — exactly the bug that shipped twice
# (GenerateToolbar delayDuration=300 → user-reported wrong timing, #337; and
# ThumbnailHoverPreview delayDuration=200). Tooltips INHERIT the app
# provider; a component never nests another.
#
# Banned: any JSX use of <TooltipProvider ...> in packages/web/src outside
# the allowlist below.
#
# Allowed (by design, not loopholes):
#   - App.tsx — the single app-level provider (the one true source).
#   - components/ui/tooltip.tsx — the primitive definition; its `<TooltipProvider>`
#     occurrences are JSDoc usage examples, not real JSX (the re-export itself
#     is a `const` with no `<`). A plain-text grep can't tell comment from code,
#     so the primitive file is exempted wholesale.
#   - pages/_dev/** — dev-only galleries render in isolation, not the app tree.
#   - tests (__tests__/ , *.test.* , *.spec.*) — a unit test wraps the
#     component under test in the provider the real app supplies at runtime.
#
# Exit: 0 clean · 1 violation · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-single-tooltip-provider.sh

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/web/src"
[ -d "$SRC" ] || { echo "single-tooltip-provider: $SRC not found" >&2; exit 2; }

# Matcher self-test (guard-matcher-self-test discipline): App.tsx is a KNOWN
# positive — it always mounts the one provider. If the matcher finds nothing
# there, grep is broken (bad path / flag / renamed file) and a "clean" verdict
# would be a false negative that silently lets nested providers into main.
# Refuse to report clean when the matcher can't see its own known positive.
if ! grep -q '<TooltipProvider' "$SRC/App.tsx" 2>/dev/null; then
  echo "single-tooltip-provider: matcher self-test FAILED — App.tsx should" >&2
  echo "  contain <TooltipProvider> but the matcher found none; grep is broken." >&2
  exit 2
fi

# JSX usage of the provider (opening tag `<TooltipProvider`). See the allowlist
# comment above for why each path is exempt.
hits="$(grep -rn '<TooltipProvider' "$SRC" \
  --include='*.tsx' \
  | grep -v '/App\.tsx:' \
  | grep -v '/components/ui/tooltip\.tsx:' \
  | grep -v '/pages/_dev/' \
  | grep -v '/__tests__/' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  || true)"

if [ -n "$hits" ]; then
  echo "❌ single-tooltip-provider: nested <TooltipProvider> outside App.tsx —"
  echo "   tooltips must inherit the ONE app-level provider (App.tsx). A"
  echo "   nested provider overrides the shared delay timing and breaks"
  echo "   skip-delay grouping. Remove it; the tooltip inherits App's provider."
  echo ""
  echo "$hits"
  exit 1
fi

echo "✓ single-tooltip-provider: only App.tsx mounts a TooltipProvider"
exit 0
