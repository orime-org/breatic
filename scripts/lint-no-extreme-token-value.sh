#!/usr/bin/env bash
# no-extreme-token-value guard — lock the pure-neutral + off-extreme + scheme-D
# status-readability invariants of the design system (9th-rebuild final spec).
#
# Three checks, all anti-drift gates for the token set (DESIGN.md §5.2 / §5.4):
#   1. Pure neutral R=G=B — every --neutral-* (and any direct-hex --color-*
#      surface override) has equal R/G/B channels (zero hue, no warm/cool tint).
#   2. Off-extreme bounds — no channel brighter than #f5 (245) or darker than
#      #12 (18); never #fff / #000. Lightest token = #f5f5f5, darkest = #141414.
#   3. Status readability — every status -foreground clears WCAG AA 4.5:1 on its
#      own tint -bg color-mix composited over the page surface, in BOTH modes.
#
# Status colours (chromatic by design), brand/logo, and the note (yellow
# sticky-note) token are exempt from checks 1–2. There is no longer a
# `destructive` solid button (red-narrowing: delete buttons use the error
# tint now) so it is not checked.
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
const D = Object.assign({}, L, vars(darkCss)); // dark = light then dark overrides

function resolve(map, v, depth = 0) {
  if (depth > 5 || v == null) return v;
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(v.trim());
  return m ? resolve(map, map[m[1]], depth + 1) : v;
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
const EXEMPT = /(status|brand|note|canvas-grid|shadow|destructive)/i;
const AA = 4.5;
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

// --- check 3: status -foreground readability (WCAG AA on tint bg) -----------
const STATUSES = ['selected', 'info', 'success', 'warning', 'error'];
for (const mode of ['light', 'dark']) {
  const map = mode === 'light' ? L : D;
  const surface = hex2rgb(resolve(map, map['--color-background']));
  for (const s of STATUSES) {
    const bgFormula = resolve(map, map[`--color-status-${s}-bg`]);
    const fgVal = resolve(map, map[`--color-status-${s}-foreground`]);
    if (!bgFormula || !fgVal) { rows.push(`FAIL ${mode} status-${s} — missing token`); fail = true; continue; }
    const bg = mixOver(bgFormula, surface);
    if (!bg) { rows.push(`FAIL ${mode} status-${s} — bg is not a color-mix tint: ${bgFormula}`); fail = true; continue; }
    const r = ratio(hex2rgb(fgVal), bg);
    const ok = r >= AA;
    if (!ok) fail = true;
    rows.push(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(5)} status-${s.padEnd(8)} ${fgVal} on ${toHex(bg)} = ${r.toFixed(2)}:1`);
  }
}

console.log(rows.join('\n'));
if (fail) {
  console.error('\nlint-no-extreme-token-value: FAIL — neutral/off-extreme/status invariant violated');
  process.exit(1);
}
console.log('\nlint-no-extreme-token-value: clean ✅ (pure neutral R=G=B + off-extreme + status ≥ 4.5:1, both modes)');
NODE
