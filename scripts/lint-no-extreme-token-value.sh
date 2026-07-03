#!/usr/bin/env bash
# no-extreme-token-value guard — lock the pure-neutral + off-extreme + palette
# structure invariants of the design system (#1549 seven-color palette).
#
# Three checks, all anti-drift gates for the token set:
#   1. Pure neutral R=G=B — every --neutral-* (and any direct-hex --color-*
#      surface override) has equal R/G/B channels (zero hue, no warm/cool tint).
#   2. Off-extreme bounds — no channel brighter than #f5 (245) or darker than
#      #12 (18); never #fff / #000. Lightest token = #f5f5f5, darkest = #141414.
#   3. Palette structure (#1549) — the 7 --color-palette-* identities each have
#      a hand-tuned light value AND a DIFFERENT hand-tuned dark override (the
#      "one pair per theme" mandate — a single flattened value is the exact
#      failure mode the palette replaced); their -bg/-border tints are
#      color-mix derivations of the identity; the 5 status tokens are pure
#      aliases into the palette (foreground = the identity itself) with no
#      scheme-D dark foreground overrides left behind.
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
#   pnpm lint:no-extreme-token-value   (wired in package.json + CI)
set -euo pipefail

TOKENS="${1:-packages/web/src/theme/tokens.css}"
[ -f "$TOKENS" ] || { echo "lint-no-extreme-token-value: tokens file not found: $TOKENS" >&2; exit 2; }

node - "$TOKENS" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const css = fs.readFileSync(file, 'utf8');

// --- split light vs dark var maps (dark = html[data-theme='dark'] { ... }) --
function darkRange(s) {
  // Match the actual dark-block selector (html[data-theme='dark'] {), NOT a
  // mention inside a comment — the selector must be immediately followed by
  // optional whitespace + the opening brace (a comment mention is not, so it
  // is skipped). indexOf("data-theme='dark'") used to hit the header comment.
  const sel = /html\[data-theme=['"]dark['"]\]\s*\{/.exec(s);
  if (!sel) return null;
  const open = sel.index + sel[0].length - 1;
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) return [open, j + 1]; }
  }
  return [open, s.length];
}
const dr = darkRange(css);
const darkCss = dr ? css.slice(dr[0], dr[1]) : '';
const lightCss = dr ? css.slice(0, dr[0]) + css.slice(dr[1]) : css;

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
// chromatic-by-design / not-a-neutral tokens — exempt from R=G=B + off-extreme
const EXEMPT = /(palette|status|brand|note|canvas-grid|shadow|destructive)/i;
let fail = false;
const rows = [];

// --- check 1 + 2: pure neutral R=G=B + off-extreme bounds -------------------
// Check --neutral-* primitives and any DIRECT-hex --color-* surface override
// (var()-derived tokens inherit their primitive's compliance, already checked).
for (const mode of ['light', 'dark']) {
  const map = mode === 'light' ? L : D;
  for (const [name, raw] of Object.entries(map)) {
    const isNeutral = /^--neutral-/.test(name);
    const isColor = /^--color-/.test(name) && !EXEMPT.test(name);
    if (!isNeutral && !isColor) continue;
    if (!HEX.test(raw.trim())) continue; // skip var()/color-mix/keyword — primitive carries the check
    const [r, g, b] = hex2rgb(raw);
    if (!(r === g && g === b)) {
      rows.push(`FAIL ${mode.padEnd(5)} ${name} ${raw} — not R=G=B (neutral must have equal channels)`);
      fail = true; continue;
    }
    if (r > 245) { rows.push(`FAIL ${mode.padEnd(5)} ${name} ${raw} — brighter than #f5f5f5 (off-extreme upper bound)`); fail = true; }
    else if (r < 18) { rows.push(`FAIL ${mode.padEnd(5)} ${name} ${raw} — darker than #121212 (off-extreme floor)`); fail = true; }
  }
}

// --- check 3: palette structure (#1549) --------------------------------------
const PALETTE = ['red', 'orange', 'green', 'blue', 'violet', 'pink', 'teal'];
// status → the palette color it must alias to
const STATUS_ALIASES = { selected: 'violet', info: 'blue', success: 'green', warning: 'orange', error: 'red' };

// 3a. each palette identity: hand-tuned light hex + a DIFFERENT dark hex
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
  if (light.trim().toLowerCase() === dark.trim().toLowerCase()) {
    rows.push(`FAIL       ${name} — light and dark are identical (${light}); flattened values are the failure mode #1549 replaced`); fail = true;
  }
  // tints must be color-mix derivations referencing the identity via var()
  for (const [suffix, pct] of [['-bg', '14'], ['-border', '40']]) {
    const tint = L[name + suffix];
    const wanted = new RegExp(`color-mix\\(in srgb,\\s*var\\(${name}\\)\\s+${pct}%\\s*,\\s*transparent\\)`, 'i');
    if (!tint || !wanted.test(tint)) {
      rows.push(`FAIL       ${name}${suffix} — must be color-mix(in srgb, var(${name}) ${pct}%, transparent), got: ${tint ?? 'missing'}`);
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
