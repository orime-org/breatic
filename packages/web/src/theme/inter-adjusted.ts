// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Self-hosted Inter with vertical-metrics overrides (#1777).
 *
 * Inter's native metrics are strongly asymmetric — per em, ascent 969 vs
 * descent 241 (~4:1). Because a line box's baseline is positioned by the
 * PRIMARY font's metrics (Inter is `--font-sans`'s first entry, so it forms
 * the strut even for CJK lines it renders no glyphs for), that asymmetry puts
 * the baseline low in the line box: Latin text reads low and CJK — which hangs
 * off Inter's baseline via the fallback font — reads high with extra space
 * below. `text-box-trim` only fixes Latin (its `cap`/`alphabetic` edges do not
 * bound CJK, real-machine verified), so we rebalance the strut instead.
 *
 * `ascent-override`/`descent-override` re-center glyphs in every fixed
 * line-height box at once — no per-element markup. The 74/34 split was
 * calibrated on the real machine under the app's real condition (fixed
 * line-heights, e.g. text-sm 13px/18px): it centers both Latin and CJK, which
 * default-Inter positions high in the same direction. See the DD note
 * (2026-07-18 inter-vertical-metrics, option B).
 *
 * Delivery mirrors `@fontsource/inter`'s CSS (per-subset `@font-face` with
 * `unicode-range`, so subsets still download lazily) but adds the override
 * descriptors. It replaces the `@fontsource/inter/*.css` imports in index.tsx.
 *
 * Old browsers without metric-override support ignore the descriptors and fall
 * back to Inter's native metrics — graceful degradation, no breakage.
 */

// Calibrated on the real machine (#1777). Ratio drives the baseline shift;
// line-gap 0 keeps the strut tight (every UI text has an explicit line-height,
// so the shrunk `normal` line-height is not exercised).
const ASCENT_OVERRIDE = '74%';
const DESCENT_OVERRIDE = '34%';
const LINE_GAP_OVERRIDE = '0%';

/**
 * `unicode-range` per Inter subset, copied verbatim from `@fontsource/inter`
 * (v5.2.8). Ranges are identical across weights; keyed by the subset slug that
 * appears in each file name (`inter-<subset>-<weight>-normal.woff2`).
 */
const UNICODE_RANGES: Readonly<Record<string, string>> = {
  'cyrillic-ext':
    'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  'greek-ext': 'U+1F00-1FFF',
  greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  vietnamese:
    'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
  'latin-ext':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};

/**
 * Every Inter woff2 shipped by `@fontsource`, eagerly resolved to its built URL.
 * Globs this package's own `node_modules` (relative to this file) so the path
 * stays inside the Vite root and resolves through pnpm's `@fontsource` symlink.
 */
const fontUrls = import.meta.glob<string>(
  '../../node_modules/@fontsource/inter/files/inter-*-normal.woff2',
  { eager: true, query: '?url', import: 'default' },
);

/**
 * Parse the subset slug and weight out of an Inter file name.
 * @param path - Absolute module path of a woff2 file.
 * @returns The subset slug and numeric weight, or null if the name does not
 *   match the `inter-<subset>-<weight>-normal.woff2` shape.
 */
function parseFontFile(
  path: string,
): { subset: string; weight: number } | null {
  const name = path.split('/').pop() ?? '';
  const match = name.match(/^inter-(.+)-(\d+)-normal\.woff2$/);
  if (!match) return null;
  return { subset: match[1], weight: Number(match[2]) };
}

/**
 * Build the `@font-face` CSS text for the adjusted Inter faces.
 * @returns One `@font-face` block per resolved woff2, with the metric
 *   overrides and the subset's `unicode-range`.
 * @throws {Error} If the glob resolved no Inter files (wrong path / version).
 */
function buildFontFaceCss(): string {
  const blocks: string[] = [];
  for (const [path, url] of Object.entries(fontUrls)) {
    const parsed = parseFontFile(path);
    if (!parsed) continue;
    const range = UNICODE_RANGES[parsed.subset];
    if (!range) continue;
    const weight = parsed.weight;
    blocks.push(
      `@font-face{font-family:'Inter';font-style:normal;font-display:swap;font-weight:${weight};ascent-override:${ASCENT_OVERRIDE};descent-override:${DESCENT_OVERRIDE};line-gap-override:${LINE_GAP_OVERRIDE};src:url(${url}) format('woff2');unicode-range:${range};}`,
    );
  }
  if (blocks.length === 0) {
    throw new Error(
      'inter-adjusted: no Inter woff2 files resolved — check the @fontsource glob path/version',
    );
  }
  return blocks.join('');
}

const style = document.createElement('style');
style.setAttribute('data-inter-adjusted', '');
style.textContent = buildFontFaceCss();
document.head.appendChild(style);
