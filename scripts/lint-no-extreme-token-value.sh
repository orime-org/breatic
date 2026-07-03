#!/usr/bin/env bash
# no-extreme-token-value guard — lock the pure-neutral + off-extreme + palette
# structure invariants of the design system (#1549 seven-color palette).
#
# Three checks, all anti-drift gates for the token set:
#   1. Pure neutral R=G=B — every --neutral-* (and any direct-hex --color-*
#      surface override) has equal R/G/B channels (zero hue, no warm/cool tint).
#      Neutral primitives MUST be plain hex — rgb()/hsl()/etc. would silently
#      bypass the channel check, so non-hex neutrals fail outright.
#   2. Off-extreme bounds — no channel brighter than #f5 (245) or darker than
#      #12 (18); never #fff / #000. Lightest token = #f5f5f5, darkest = #141414.
#   3. Palette structure (#1549) — EXACTLY the 7 --color-palette-* identities
#      (red/orange/green/blue/violet/pink/teal; extras fail), each with a
#      hand-tuned light value AND a genuinely different dark override (hex
#      compared by RGB value, so #c23 vs #cc2233 counts as flattened); their
#      -bg/-border tints are exactly the canonical color-mix derivation of the
#      identity; every palette declaration lives OUTSIDE @theme (Tailwind 4
#      tree-shakes @theme vars without literal consumers — pink/teal tints are
#      reached only via runtime-built var() names, so @theme placement strips
#      them from production builds); the 5 status tokens are pure aliases into
#      the palette (foreground = the identity itself) with no scheme-D dark
#      foreground overrides left behind.
#      WCAG contrast is PRINTED FOR REFERENCE ONLY and never fails the build —
#      color values are hand-tuned by eye per theme (user decision 2026-07-03),
#      not derived from contrast math.
#
# Palette / status colours (chromatic by design), brand/logo, and the note
# (yellow sticky-note) token are exempt from checks 1–2.
#
# Exit: 0 clean · 1 violation · 2 misconfiguration.
#
# Usage:
#   ./scripts/lint-no-extreme-token-value.sh                  # real tokens.css
#   ./scripts/lint-no-extreme-token-value.sh <tokens.css>     # a fixture (tests)
#   ./scripts/lint-no-extreme-token-value.sh --self-test      # mutation fixtures
#   pnpm lint:no-extreme-token-value   (wired in package.json + CI; runs the
#                                       real file AND the self-test)
#
# --self-test: mutates the REAL tokens.css into known-bad fixtures (each one a
# violation the adversarial audit 2026-07-03 proved could slip through earlier
# revisions) and asserts the guard now catches every one of them, plus asserts
# the unmutated file stays clean. This keeps the guard itself guarded.
set -euo pipefail

REAL_TOKENS="packages/web/src/theme/tokens.css"

if [ "${1:-}" = "--self-test" ]; then
  [ -f "$REAL_TOKENS" ] || { echo "self-test: real tokens file not found: $REAL_TOKENS" >&2; exit 2; }
  TMPDIR_ST="$(mktemp -d)"
  trap 'rm -rf "$TMPDIR_ST"' EXIT
  fail=0

  # Each fixture: <name> <sed/python mutation> — must make the guard exit 1.
  run_case() {
    local name="$1" file="$2" want="$3"
    if bash "$0" "$file" >/dev/null 2>&1; then got=0; else got=1; fi
    if [ "$got" -ne "$want" ]; then
      echo "self-test FAIL: $name (want exit $want, got $got)"
      fail=1
    else
      echo "self-test ok:   $name"
    fi
  }

  # 0. The real file must be clean.
  run_case "real-file-clean" "$REAL_TOKENS" 0

  # 1. 8th palette color (light-only, wrong tint pcts) must be caught.
  python3 - "$REAL_TOKENS" "$TMPDIR_ST/eighth.css" <<'PY'
import sys
s = open(sys.argv[1]).read()
s = s.replace("--color-palette-teal: #008573;",
  "--color-palette-teal: #008573;\n  --color-palette-yellow: #9e6c00;\n  --color-palette-yellow-bg: color-mix(in srgb, var(--color-palette-yellow) 60%, transparent);\n  --color-palette-yellow-border: color-mix(in srgb, var(--color-palette-yellow) 90%, transparent);", 1)
open(sys.argv[2], 'w').write(s)
PY
  run_case "eighth-color-caught" "$TMPDIR_ST/eighth.css" 1

  # 2. Non-hex neutral (hsl) must be caught.
  sed 's/--neutral-500: #5f5f5f;/--neutral-500: hsl(30, 45%, 40%);/' "$REAL_TOKENS" > "$TMPDIR_ST/hsl-neutral.css"
  run_case "hsl-neutral-caught" "$TMPDIR_ST/hsl-neutral.css" 1

  # 3. Non-hex direct --color-* surface (pure-white rgb) must be caught.
  sed 's/--color-background: #f0f0f0;/--color-background: rgb(255, 255, 255);/' "$REAL_TOKENS" > "$TMPDIR_ST/rgb-bg.css"
  run_case "rgb-background-caught" "$TMPDIR_ST/rgb-bg.css" 1

  # 4. Second dark block flattening a palette color must be caught.
  { cat "$REAL_TOKENS"; printf "\nhtml[data-theme='dark'] {\n  --color-palette-red: #ce2c31;\n}\n"; } > "$TMPDIR_ST/second-dark.css"
  run_case "second-dark-block-caught" "$TMPDIR_ST/second-dark.css" 1

  # 5. Nested color-mix diluting the tint (substring evasion) must be caught.
  python3 - "$REAL_TOKENS" "$TMPDIR_ST/nested-mix.css" <<'PY'
import sys
s = open(sys.argv[1]).read()
s = s.replace(
  "--color-palette-red-bg: color-mix(in srgb, var(--color-palette-red) 14%, transparent);",
  "--color-palette-red-bg: color-mix(in srgb, color-mix(in srgb, var(--color-palette-red) 14%, transparent) 20%, #ffffff);", 1)
open(sys.argv[2], 'w').write(s)
PY
  run_case "nested-mix-caught" "$TMPDIR_ST/nested-mix.css" 1

  # 6. Light/dark flattened via 3- vs 6-digit hex must be caught.
  python3 - "$REAL_TOKENS" "$TMPDIR_ST/notation-flatten.css" <<'PY'
import sys, re
s = open(sys.argv[1]).read()
s = s.replace("--color-palette-red: #ce2c31;", "--color-palette-red: #c23;", 1)   # light → #cc2233
s = s.replace("--color-palette-red: #ff9592;", "--color-palette-red: #cc2233;", 1) # dark → same color
open(sys.argv[2], 'w').write(s)
PY
  run_case "notation-flatten-caught" "$TMPDIR_ST/notation-flatten.css" 1

  # 7. Palette declared inside @theme (tree-shake hazard) must be caught.
  python3 - "$REAL_TOKENS" "$TMPDIR_ST/palette-in-theme.css" <<'PY'
import sys
s = open(sys.argv[1]).read()
block = "  --color-palette-red: #ce2c31;\n"
assert block in s
s = s.replace(block, "", 1)  # remove from :root (also breaks pair — but the placement check must fire too)
s = s.replace("@theme {", "@theme {\n  --color-palette-red: #ce2c31;", 1)
open(sys.argv[2], 'w').write(s)
PY
  run_case "palette-in-theme-caught" "$TMPDIR_ST/palette-in-theme.css" 1

  # 8. Wrong alias wiring (error → blue) must be caught.
  sed 's|--color-status-error: var(--color-palette-red);|--color-status-error: var(--color-palette-blue);|' "$REAL_TOKENS" > "$TMPDIR_ST/cross-wire.css"
  run_case "alias-cross-wire-caught" "$TMPDIR_ST/cross-wire.css" 1

  if [ "$fail" -ne 0 ]; then
    echo "lint-no-extreme-token-value --self-test: FAIL" >&2
    exit 1
  fi
  echo "lint-no-extreme-token-value --self-test: clean ✅ (8 mutation fixtures all caught, real file clean)"
  exit 0
fi

TOKENS="${1:-$REAL_TOKENS}"
[ -f "$TOKENS" ] || { echo "lint-no-extreme-token-value: tokens file not found: $TOKENS" >&2; exit 2; }

node - "$TOKENS" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const css = fs.readFileSync(file, 'utf8');

// --- locate ALL dark blocks (html[data-theme='dark'] { ... }) ---------------
// The cascade lets a LATER block override an earlier one, so a second dark
// block re-flattening a palette color must be parsed too — merge every block
// in document order (adversarial audit 2026-07-03: single-.exec() let block
// two masquerade as light CSS).
function blockRanges(s, selectorRe) {
  const ranges = [];
  const re = new RegExp(selectorRe, 'g');
  let sel;
  while ((sel = re.exec(s))) {
    const open = sel.index + sel[0].length - 1;
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) { ranges.push([open, j + 1]); re.lastIndex = j + 1; break; } }
    }
  }
  return ranges;
}
const darkRanges = blockRanges(css, "html\\[data-theme=['\"]dark['\"]\\]\\s*\\{");
const themeRanges = blockRanges(css, "@theme\\s*\\{");
const darkCss = darkRanges.map(([a, b]) => css.slice(a, b)).join('\n');
let lightCss = css;
for (const [a, b] of [...darkRanges].reverse()) lightCss = lightCss.slice(0, a) + lightCss.slice(b);

function vars(block) {
  const m = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let x;
  while ((x = re.exec(block))) m[x[1]] = x[2].trim();
  return m;
}
const L = vars(lightCss);
const DARK_OVERRIDES = vars(darkCss);
const D = Object.assign({}, L, DARK_OVERRIDES); // dark = light then dark overrides

function resolve(map, v, depth = 0) {
  if (depth > 5 || v == null) return v;
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v.trim());
  return m ? resolve(map, map[m[1]], depth + 1) : v;
}

// Replace every var(--x) INSIDE a longer expression (e.g. a color-mix formula)
// with its resolved value from the map — needed since #1549 tints reference
// their identity via var() instead of repeating the hex.
function inlineVars(map, expr, depth = 0) {
  if (depth > 5 || expr == null) return expr;
  const next = expr.replace(/var\((--[a-z0-9-]+)\)/gi, (_, name) => map[name] ?? `var(${name})`);
  return next === expr ? next : inlineVars(map, next, depth + 1);
}

// --- WCAG colour helpers ----------------------------------------------------
function hex2rgb(h) {
  h = h.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(rgb) { return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]); }
function ratio(a, b) { const la = lum(a), lb = lum(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return (hi + 0.05) / (lo + 0.05); }
// color-mix(in srgb, <hex> <pct>%, transparent) composited over a surface
function mixOver(formula, surface) {
  const m = /color-mix\(in srgb,\s*(#[0-9a-f]{3,6})\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\)/i.exec(formula || '');
  if (!m) return null;
  const c = hex2rgb(m[1]); const a = parseFloat(m[2]) / 100;
  return c.map((v, i) => v * a + surface[i] * (1 - a));
}
const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
// rgb()/rgba() carry readable channels — parse them so the R=G=B +
// off-extreme checks still apply (a translucent neutral hairline like
// rgba(30,30,30,.12) is legitimate; rgb(255,255,255) is not). Other
// functional notations (hsl/oklch/…) hide the channels — violations.
const RGB_FN = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;
const NON_CHECKABLE_DIRECT = /^(hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i;
// chromatic-by-design / not-a-neutral tokens — exempt from R=G=B + off-extreme
const EXEMPT = /(palette|status|brand|note|canvas-grid|shadow|destructive)/i;
let fail = false;
const rows = [];

// --- check 1 + 2: pure neutral R=G=B + off-extreme bounds -------------------
// Check --neutral-* primitives and any DIRECT-value --color-* surface override
// (var()/color-mix references inherit their primitive's compliance).
for (const mode of ['light', 'dark']) {
  const map = mode === 'light' ? L : D;
  for (const [name, raw] of Object.entries(map)) {
    const isNeutral = /^--neutral-/.test(name);
    const isColor = /^--color-/.test(name) && !EXEMPT.test(name);
    if (!isNeutral && !isColor) continue;
    const v = raw.trim();
    let channels = null;
    if (HEX.test(v)) {
      channels = hex2rgb(v);
    } else {
      const m = RGB_FN.exec(v);
      if (m) {
        channels = [Number(m[1]), Number(m[2]), Number(m[3])];
      } else if (NON_CHECKABLE_DIRECT.test(v)) {
        rows.push(`FAIL ${mode.padEnd(5)} ${name} ${v} — functional notation hides the channels from the neutral/off-extreme checks; use hex or rgb()/rgba()`);
        fail = true;
        continue;
      } else if (isNeutral) {
        rows.push(`FAIL ${mode.padEnd(5)} ${name} ${v} — neutral primitives must be plain hex (got a reference/expression)`);
        fail = true;
        continue;
      } else {
        continue; // var()/color-mix on --color-*: primitive carries the check
      }
    }
    const [r, g, b] = channels;
    if (!(r === g && g === b)) {
      rows.push(`FAIL ${mode.padEnd(5)} ${name} ${v} — not R=G=B (neutral must have equal channels)`);
      fail = true; continue;
    }
    if (r > 245) { rows.push(`FAIL ${mode.padEnd(5)} ${name} ${v} — brighter than #f5f5f5 (off-extreme upper bound)`); fail = true; }
    else if (r < 18) { rows.push(`FAIL ${mode.padEnd(5)} ${name} ${v} — darker than #121212 (off-extreme floor)`); fail = true; }
  }
}

// --- check 3: palette structure (#1549) --------------------------------------
const PALETTE = ['red', 'orange', 'green', 'blue', 'violet', 'pink', 'teal'];
// status → the palette color it must alias to
const STATUS_ALIASES = { selected: 'violet', info: 'blue', success: 'green', warning: 'orange', error: 'red' };

// 3a-0. EXACTLY the expected palette token set — an 8th color (or a stray
// suffix) must fail, not silently skip (audit: allowlist-only checking let
// --color-palette-yellow through untouched).
const EXPECTED_PALETTE_TOKENS = new Set(
  PALETTE.flatMap((p) => [`--color-palette-${p}`, `--color-palette-${p}-bg`, `--color-palette-${p}-border`]),
);
for (const map of [L, DARK_OVERRIDES]) {
  for (const name of Object.keys(map)) {
    if (name.startsWith('--color-palette-') && !EXPECTED_PALETTE_TOKENS.has(name)) {
      rows.push(`FAIL       ${name} — not part of the ratified 7-color palette (extras need a new user decision + guard update)`);
      fail = true;
    }
  }
}

// 3a-1. no palette declaration may live inside @theme — Tailwind 4 tree-shakes
// @theme vars without literal utility consumers, and the pink/teal tints are
// consumed only via runtime-built var() names, so @theme placement strips them
// from production builds (audit 2026-07-03: pink-border vanished from dist).
{
  const re = /--color-palette-[a-z0-9-]+\s*:/gi;
  let m;
  while ((m = re.exec(css))) {
    if (themeRanges.some(([a, b]) => m.index > a && m.index < b)) {
      rows.push(`FAIL       ${m[0].replace(/\s*:$/, '')} — declared inside @theme; palette tokens must live in :root (tree-shake hazard)`);
      fail = true;
    }
  }
}

// 3a-2. each palette identity: hand-tuned light hex + a genuinely different
// dark hex (compared as RGB — #c23 vs #cc2233 is the same color).
for (const p of PALETTE) {
  const name = `--color-palette-${p}`;
  const light = L[name];
  const dark = DARK_OVERRIDES[name];
  if (!light || !HEX.test(light.trim())) {
    rows.push(`FAIL light ${name} — missing or not a plain hex identity`); fail = true; continue;
  }
  if (!dark || !HEX.test(dark.trim())) {
    rows.push(`FAIL dark  ${name} — missing dark override (each color is a hand-tuned LIGHT+DARK pair)`); fail = true; continue;
  }
  if (toHex(hex2rgb(light)) === toHex(hex2rgb(dark))) {
    rows.push(`FAIL       ${name} — light and dark are the same color (${light} / ${dark}); flattened values are the failure mode #1549 replaced`); fail = true;
  }
  // tints must be EXACTLY the canonical color-mix derivation (anchored — a
  // nested mix containing the formula as a substring is a different value).
  for (const [suffix, pct] of [['-bg', '14'], ['-border', '40']]) {
    const tint = L[name + suffix];
    const wanted = new RegExp(`^color-mix\\(in srgb,\\s*var\\(${name}\\)\\s+${pct}%\\s*,\\s*transparent\\)$`, 'i');
    if (!tint || !wanted.test(tint.trim())) {
      rows.push(`FAIL       ${name}${suffix} — must be exactly color-mix(in srgb, var(${name}) ${pct}%, transparent), got: ${tint ?? 'missing'}`);
      fail = true;
    }
    if (DARK_OVERRIDES[name + suffix]) {
      rows.push(`FAIL dark  ${name}${suffix} — tints must not be re-declared in dark (they track the identity via var())`);
      fail = true;
    }
  }
}

// 3b. status tokens are pure aliases into the palette; no scheme-D leftovers
for (const [s, p] of Object.entries(STATUS_ALIASES)) {
  const expectations = [
    [`--color-status-${s}`, `var(--color-palette-${p})`],
    [`--color-status-${s}-bg`, `var(--color-palette-${p}-bg)`],
    [`--color-status-${s}-foreground`, `var(--color-palette-${p})`], // text = the identity itself
    [`--color-status-${s}-border`, `var(--color-palette-${p}-border)`],
  ];
  for (const [name, expected] of expectations) {
    const got = L[name];
    if (!got || got.trim().toLowerCase() !== expected.toLowerCase()) {
      rows.push(`FAIL       ${name} — must alias ${expected}, got: ${got ?? 'missing'}`);
      fail = true;
    }
    if (DARK_OVERRIDES[name]) {
      rows.push(`FAIL dark  ${name} — status tokens must not be re-declared in dark (retired scheme-D override); dark lives in the palette identities`);
      fail = true;
    }
  }
}

// 3c. contrast REFERENCE report — printed for the record, NEVER fails.
// Values are hand-tuned by eye per theme (user decision 2026-07-03); the
// numbers below exist so a reviewer can see the landscape, not to gate it.
for (const mode of ['light', 'dark']) {
  const map = mode === 'light' ? L : D;
  const surface = hex2rgb(resolve(map, map['--color-background']));
  for (const p of PALETTE) {
    const identity = resolve(map, map[`--color-palette-${p}`]);
    const bgFormula = inlineVars(map, map[`--color-palette-${p}-bg`]);
    const bg = mixOver(bgFormula, surface);
    if (!identity || !HEX.test(identity) || !bg) continue; // structural failures already reported above
    const onTint = ratio(hex2rgb(identity), bg);
    const onPage = ratio(hex2rgb(identity), surface);
    rows.push(`ref  ${mode.padEnd(5)} palette-${p.padEnd(7)} ${identity} on tint ${toHex(bg)} = ${onTint.toFixed(2)}:1 · on page = ${onPage.toFixed(2)}:1`);
  }
}

console.log(rows.join('\n'));
if (fail) {
  console.error('\nlint-no-extreme-token-value: FAIL — neutral/off-extreme/palette-structure invariant violated');
  process.exit(1);
}
console.log('\nlint-no-extreme-token-value: clean ✅ (pure neutral R=G=B + off-extreme + 7-color palette structure; contrast printed for reference only)');
NODE
