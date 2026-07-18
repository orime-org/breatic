#!/usr/bin/env bash
# single-toast-entry guard — the whole app routes toasts through ONE wrapper
# (`@web/lib/toast`, packages/web/src/lib/toast.ts), never `sonner` directly.
# That single entry point is what makes two invariants hold everywhere:
#
#   1. TYPE — the wrapper exposes only error / warning / success / info (each
#      colored by the Toaster). It has NO untyped method, so a bare `toast()` /
#      `toast.message()` cannot compile against it (TypeScript rejects the call).
#      This SUBSUMES the old no-restricted-syntax "toast must be typed" rule.
#   2. DE-DUP — the wrapper adds a stable id from `type + message`, so rapidly
#      re-firing the same notice REFRESHES one toast instead of stacking a pile
#      of collapsed bars (user 2026-07-18, "new refreshes old").
#
# Importing `toast` straight from 'sonner' anywhere else bypasses BOTH, so it is
# banned.
#
# Banned: any `import { toast ... } from 'sonner'` in packages/web/src outside
# the allowlist below.
#
# Allowed (by design, not loopholes):
#   - lib/toast.ts          — the wrapper itself (it imports `toast as
#                             sonnerToast` — the one legitimate sonner toast import).
#   - components/ui/sonner.tsx — the Toaster surface (imports `Toaster`, not
#                             `toast`; exempted wholesale so a future edit there
#                             is never mistaken for a bypass).
#   - tests (__tests__/ , *.test.* , *.spec.*) — a test mocks / spies on sonner
#     directly; the wrapper delegates to sonner, so a sonner-level spy still
#     observes the call.
#   - pages/_dev/**         — dev-only galleries render in isolation.
#
# Exit: 0 clean · 1 violation · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-single-toast-entry.sh

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/web/src"
WRAPPER="$SRC/lib/toast.ts"
[ -d "$SRC" ] || { echo "single-toast-entry: $SRC not found" >&2; exit 2; }

# Matcher self-test (guard-matcher-self-test discipline): the wrapper is a KNOWN
# positive — it always imports `toast as sonnerToast` from 'sonner'. If the
# matcher finds nothing there, grep is broken (bad path / flag / renamed file)
# and a "clean" verdict would be a false negative that silently lets direct
# sonner toast imports into main. Refuse to report clean when the matcher can't
# see its own known positive.
if ! grep -Eq "^import .*\btoast\b.* from 'sonner'" "$WRAPPER" 2>/dev/null; then
  echo "single-toast-entry: matcher self-test FAILED — the wrapper" >&2
  echo "  ($WRAPPER) should import toast from 'sonner' but the matcher found" >&2
  echo "  none; grep is broken (renamed/moved wrapper?)." >&2
  exit 2
fi

# `import { toast ... } from 'sonner'` at line start (imports are never
# indented in these files, so `^import` skips commented-out lines). See the
# allowlist comment above for why each path is exempt.
hits="$(grep -rnE "^import .*\btoast\b.* from 'sonner'" "$SRC" \
  --include='*.ts' --include='*.tsx' \
  | grep -v '/lib/toast\.ts:' \
  | grep -v '/components/ui/sonner\.tsx:' \
  | grep -v '/pages/_dev/' \
  | grep -v '/__tests__/' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  || true)"

if [ -n "$hits" ]; then
  echo "❌ single-toast-entry: 'toast' imported straight from 'sonner' —" >&2
  echo "   route it through the wrapper instead: import { toast } from '@web/lib/toast'" >&2
  echo "   (the wrapper adds the semantic type + content de-dup id). Offending lines:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "single-toast-entry: clean ✅ (all toasts route through @web/lib/toast)"
exit 0
