#!/usr/bin/env bash
# no-native-rendered-ui guard — for a creative product, any interactive
# control whose visual skin is drawn by the BROWSER / OS renders differently
# per engine (Chrome vs Safari vs Firefox), and that inconsistency is fatal.
# So every such surface must be self-rendered (a Radix primitive or a
# self-drawn component), never a native element. This is the GENERAL rule
# behind the earlier single-point guards (no-inline-scrollbar for scrollbars);
# it generalises the lesson so each new native primitive (color, then range,
# then date…) is caught mechanically instead of one-by-one in review.
# See the "no browser/OS-native-rendered UI" mandate in packages/web/CLAUDE.md.
#
# BANNED in packages/web/src ts/tsx (tests + pages/_dev excluded), because the
# browser/OS draws their chrome:
#   - <input type=color>              → native swatch + OS colour dialog
#   - <input type=date|time|...>      → native calendar / spinner popup
#   - <input type=range>              → native slider thumb/track (use Slider)
#   - <select>                        → native OS-drawn option list (use Select)
#   - <audio|video controls>          → native OS media player (use MediaPlayer)
#
# The attribute-quote requirement (type='range' etc.) means bare prose like a
# doc comment `<input type=range>` (no quotes) never matches — only real JSX,
# which always quotes string attributes, trips the guard.
#
# Not mechanically greppable (too noisy / cross-line), so MANDATE-enforced in
# web/CLAUDE.md, not here: `title=` used as a tooltip (vs a legitimate a11y
# label on iframe/svg), and native form-validation bubbles. Disclosed so the
# guard's coverage is honest — it is NOT the full ban, the mandate is.
#
# Escape hatch (rare, justified): put `native-ui:allow` on the same line and
# it is stripped before matching. Use only with a real reason in an adjacent
# comment.
#
# Exit: 0 clean · 1 violation · 2 misconfiguration (matcher self-test failed).
#
# Usage:
#   ./scripts/lint-no-native-rendered-ui.sh                 # packages/web/src
#   ./scripts/lint-no-native-rendered-ui.sh <dir>           # a fixture dir
#   ./scripts/lint-no-native-rendered-ui.sh --self-test     # matcher self-check
#   pnpm lint:no-native-rendered-ui   (wired in package.json + CI)
set -euo pipefail

# Native controls whose visual skin the browser/OS draws. ASCII-only so it is
# BSD-grep safe. Quotes required around the type value so bare prose misses.
PAT="type=['\"](color|date|time|datetime-local|month|week|range)['\"]"
PAT="$PAT|<select[[:space:]/>]"
PAT="$PAT|<(audio|video)[^>]*[[:space:]]controls([[:space:]]|/|>)"
# Lines carrying the escape marker are exempt in full.
ALLOW_MARKER='native-ui:allow'

scan() {
  # $1 = root dir. Prints matching "file:line:content", empty if clean.
  # Comment lines (JSDoc `*` continuation, `//` line comments) are dropped:
  # documentation legitimately NAMES the banned forms (e.g. "replaces the
  # native <input type=color>"), and a scanning guard must not blow up on its
  # own subject matter (the guard-self-scan-footprint trap). Real violations
  # are JSX, never comment lines.
  find "$1" \( -name '*.tsx' -o -name '*.ts' \) \
    -not -name '*.test.ts' -not -name '*.test.tsx' \
    -not -path '*/__tests__/*' -not -path '*/pages/_dev/*' -print0 \
    | LC_ALL=C xargs -0 grep -nE "$PAT" 2>/dev/null \
    | LC_ALL=C grep -vF "$ALLOW_MARKER" \
    | LC_ALL=C awk -F: '{ body=$0; sub(/^[^:]+:[0-9]+:/, "", body);
        if (body ~ /^[[:space:]]*(\*|\/\/)/) next; print }' \
    || true
}

self_test() {
  # Prove the matcher catches known positives and passes known negatives —
  # else a broken matcher would report "clean" silently (guard-matcher trap).
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  # Positives: one per banned form.
  cat > "$tmp/bad.tsx" <<'FIX'
export const a = <input type="color" />;
export const b = <input type='range' min={0} />;
export const c = <input type="date" />;
export const d = <select><option>x</option></select>;
export const e = <video controls src="x" />;
FIX
  # Negatives: the self-drawn replacements + a doc-comment bare form + an
  # allow-marked line must all pass.
  cat > "$tmp/good.tsx" <<'FIX'
// A native `<input type=range>` (bare, no quotes) in prose must NOT match.
/**
 * Replaces the native `<input type="color">` (quoted, but in a JSDoc comment)
 * whose swatch differs per browser — a comment naming the banned form is fine.
 */
export const a = <Slider value={[1]} />;
export const b = <Select><SelectTrigger /></Select>;
export const c = <input type="text" />;
export const d = <input type="color" /> // native-ui:allow legacy debug panel
FIX
  local got_bad got_good
  got_bad="$(scan "$tmp" | grep -c 'bad.tsx' || true)"
  got_good="$(scan "$tmp" | grep -c 'good.tsx' || true)"
  # bad.tsx has 5 banned lines; good.tsx must be fully clean (0).
  if [ "$got_bad" -lt 5 ]; then
    echo "lint-no-native-rendered-ui: SELF-TEST FAILED — matcher caught only $got_bad/5 known positives (broken pattern)" >&2
    exit 2
  fi
  if [ "$got_good" -ne 0 ]; then
    echo "lint-no-native-rendered-ui: SELF-TEST FAILED — matcher flagged $got_good known-good lines (false positive)" >&2
    scan "$tmp" | grep 'good.tsx' >&2 || true
    exit 2
  fi
  echo "lint-no-native-rendered-ui: self-test ok ✅ (5/5 positives caught, 0 false positives)"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

ROOT="${1:-packages/web/src}"
[ -d "$ROOT" ] || { echo "lint-no-native-rendered-ui: dir not found: $ROOT" >&2; exit 2; }

HITS="$(scan "$ROOT")"
if [ -n "$HITS" ]; then
  echo "$HITS"
  echo ""
  echo "lint-no-native-rendered-ui: FAIL — native browser/OS-rendered controls render differently per engine (fatal for a creative product)."
  echo "  fix: use the self-drawn primitive instead —"
  echo "    <input type=color>  -> EmptyImageColorPicker / react-colorful in a Popover"
  echo "    <input type=range>  -> <Slider> (components/ui/slider)"
  echo "    <input type=date/…> -> a self-drawn date picker (build one in components/ui first)"
  echo "    <select>            -> <Select> (components/ui/select, Radix)"
  echo "    <audio|video controls> -> the custom MediaPlayer (no native controls attr)"
  echo "  genuinely-justified exception: add 'native-ui:allow' + a reason comment on the line."
  exit 1
fi
echo "lint-no-native-rendered-ui: clean ✅ (no native browser/OS-rendered UI controls)"
