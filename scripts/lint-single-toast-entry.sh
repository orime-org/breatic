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
# Importing from 'sonner' anywhere else bypasses BOTH, so it is banned. We match
# the import's `from 'sonner'` clause PER LINE (dropping comment lines), not the
# old `^import .*\btoast\b.* from 'sonner'` shape — that anchored matcher
# silently missed two real import shapes: a multi-line destructured import (whose
# `} from 'sonner'` continuation line is not `^import`) and an `import * as
# sonner` namespace import (which has no `toast` token). Matching `from 'sonner'`
# on any non-comment line catches all shapes.
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

# The `from 'sonner'` clause is present on an import line whatever the shape.
FROM_SONNER="from 'sonner'"
# A `path:line:content` row is a comment (not real code) when its content starts
# with a `//`, `*` (JSDoc body), or `/*` marker — used to drop mentions of the
# banned string in comments so only actual imports are flagged.
COMMENT_ROW=':[0-9]+:[[:space:]]*(//|\*|/\*)'

# Self-test 1 (known positive): the wrapper always imports from 'sonner'. If the
# matcher can't see its own known positive, grep is broken (bad path/flag/renamed
# file) and a "clean" verdict would be a false negative that silently lets direct
# sonner imports into main. Refuse to report clean when the matcher is blind.
if ! grep -qF "$FROM_SONNER" "$WRAPPER" 2>/dev/null; then
  echo "single-toast-entry: matcher self-test FAILED — the wrapper ($WRAPPER)" >&2
  echo "  should import from 'sonner' but the matcher found none (moved/renamed?)." >&2
  exit 2
fi

# Self-test 2 (shapes): the old matcher silently missed multi-line and namespace
# imports — a real merged bypass. Prove the new matcher KEEPS those import rows
# and still DROPS comment rows before trusting a clean verdict.
kept() { printf '%s\n' "$1" | grep -qvE "$COMMENT_ROW"; } # 0 = real code, 1 = comment
if ! kept "f.ts:3:} from 'sonner';" \
  || ! kept "f.ts:1:import * as sonner from 'sonner';" \
  || kept "f.ts:9: * see: import { toast } from 'sonner'"; then
  echo "single-toast-entry: shape self-test FAILED — the matcher misclassifies a" >&2
  echo "  multi-line / namespace import or a comment; it would let a bypass into main." >&2
  exit 2
fi

# Every non-exempt, non-comment line importing from 'sonner' is a bypass. See the
# allowlist comment above for why each exempt path is legitimate.
hits="$(grep -rnF "$FROM_SONNER" "$SRC" \
  --include='*.ts' --include='*.tsx' \
  | grep -v '/lib/toast\.ts:' \
  | grep -v '/components/ui/sonner\.tsx:' \
  | grep -v '/pages/_dev/' \
  | grep -v '/__tests__/' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  | grep -vE "$COMMENT_ROW" \
  || true)"

if [ -n "$hits" ]; then
  echo "❌ single-toast-entry: 'sonner' imported outside the wrapper —" >&2
  echo "   route toasts through the wrapper: import { toast } from '@web/lib/toast'" >&2
  echo "   (it adds the semantic type + content de-dup id). Offending line(s):" >&2
  echo "$hits" >&2
  exit 1
fi

echo "single-toast-entry: clean ✅ (all toasts route through @web/lib/toast)"
exit 0
