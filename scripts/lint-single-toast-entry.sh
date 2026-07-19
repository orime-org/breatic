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

# `from 'sonner'` is present on any sonner import whatever the shape (single-line,
# multi-line `} from 'sonner'`, aliased, or `import * as sonner`).
FROM_SONNER="from 'sonner'"
# Whole-file comment strip (block comments — multi-line, non-greedy — then line
# comments), so we test the import against what SURVIVES. Deciding comment-vs-code
# by a line's leading token is unsound: `/* c */ import { toast } from 'sonner'`
# OPENS with a comment but CONTINUES with a real import, and a block-comment
# INTERIOR line need not start with `*`. Stripping first flags the real import
# while a whole-line `/* ...from 'sonner'... */`, a JSDoc body, or a block interior
# all lose their match and are correctly ignored.
STRIP='s{/\*.*?\*/}{}gs; s{//[^\n]*}{}g'
caught() { printf '%s' "$1" | perl -0777 -pe "$STRIP" 2>/dev/null | grep -qF "$FROM_SONNER"; }

# Self-test 1 (known positive): the wrapper always imports from 'sonner'. If the
# matcher can't see its own known positive, grep is broken (bad path/flag/renamed
# file) and a "clean" verdict would be a false negative that silently lets direct
# sonner imports into main. Refuse to report clean when the matcher is blind.
if ! caught "$(cat "$WRAPPER" 2>/dev/null)"; then
  echo "single-toast-entry: matcher self-test FAILED — the wrapper ($WRAPPER)" >&2
  echo "  should import from 'sonner' but the matcher found none (moved/renamed?)." >&2
  exit 2
fi

# Self-test 2 (shapes): prove the strip-then-match CATCHES every real import shape
# — including a comment-prefixed and a multi-line import (the two the old
# `^import .*\btoast\b.* from 'sonner'` matcher silently missed) — and still DROPS
# pure comments (line, JSDoc body, and a block-comment interior line that does NOT
# start with `*`). These are the exact shapes the guard's own matcher-self-test
# discipline previously overlooked.
real_multiline=$'import {\n  toast,\n} from \'sonner\';'
comment_prefixed="/* eslint-disable */ import { toast } from 'sonner';"
jsdoc_body=$'/**\n * Then import { toast } from \'sonner\'.\n */'
block_interior=$'/*\n  Historically we import { toast } from \'sonner\' here.\n*/'
if ! caught "import { toast } from 'sonner';" \
  || ! caught "$real_multiline" \
  || ! caught "import * as sonner from 'sonner';" \
  || ! caught "$comment_prefixed" \
  || caught "// old: import { toast } from 'sonner'" \
  || caught "$jsdoc_body" \
  || caught "$block_interior" \
  || caught "/* we used to import from 'sonner' */"; then
  echo "single-toast-entry: shape self-test FAILED — the strip-then-match matcher" >&2
  echo "  misclassifies a real import or a comment; it would let a bypass into main." >&2
  exit 2
fi

# Every non-exempt file whose code (comments stripped) still imports from 'sonner'
# is a bypass. See the allowlist comment above for why each exempt path is legit.
files="$(grep -rlF "$FROM_SONNER" "$SRC" \
  --include='*.ts' --include='*.tsx' \
  | grep -v '/lib/toast\.ts$' \
  | grep -v '/components/ui/sonner\.tsx$' \
  | grep -v '/pages/_dev/' \
  | grep -v '/__tests__/' \
  | grep -v '\.test\.' \
  | grep -v '\.spec\.' \
  || true)"

violating=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if perl -0777 -pe "$STRIP" "$f" 2>/dev/null | grep -qF "$FROM_SONNER"; then
    violating="$violating$f"$'\n'
  fi
done <<< "$files"

if [ -n "$violating" ]; then
  echo "❌ single-toast-entry: 'sonner' imported outside the wrapper —" >&2
  echo "   route toasts through the wrapper: import { toast } from '@web/lib/toast'" >&2
  echo "   (it adds the semantic type + content de-dup id). Offending line(s):" >&2
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -nF "$FROM_SONNER" "$f" | sed "s#^#$f:#" >&2
  done <<< "$violating"
  exit 1
fi

echo "single-toast-entry: clean ✅ (all toasts route through @web/lib/toast)"
exit 0
