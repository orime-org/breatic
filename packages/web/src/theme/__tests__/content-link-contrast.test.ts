// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A link written in content is body text, and reads at WCAG 2.2 SC 1.4.3,
 * 4.5:1, on every surface it is written on: the page a document is written
 * on, and a canvas note (inner#1462). The dark theme's note stays as it is
 * (user 2026-10-13), where a link reads at 3.91:1, so only its page is checked.
 *
 * Tokens rather than the screen: the value written here decides it, and a
 * measurement here catches a change to it at the moment it is made.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../tokens.css'), 'utf8');

/** WCAG 2.2 SC 1.4.3, body text. */
const AA_BODY = 4.5;

/** Where the dark theme's own block starts. */
const DARK_BLOCK = 'html[data-theme=\'dark\'] {';

/** The light theme's declarations, the dark theme's laid over them. */
const THEMES = {
  light: css.slice(0, css.indexOf(DARK_BLOCK)),
  dark: css,
} as const;

/**
 * A custom property's value in a theme, following `var()` to a literal.
 * @param theme - The theme's declarations.
 * @param name - The property, without its dashes.
 * @returns The literal it comes to.
 */
function literal(theme: string, name: string): string {
  const found = [...theme.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].at(-1)![1]!.trim();
  const alias = /^var\(--([\w-]+)\)$/.exec(found);
  return alias === null ? found : literal(theme, alias[1]!);
}

/**
 * The relative luminance WCAG defines, of a `#rrggbb` literal.
 * @param hex - The literal.
 * @returns Its luminance, 0 to 1.
 */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The contrast between two colours, as WCAG states it.
 * @param a - One colour.
 * @param b - The other.
 * @returns The ratio, 1 to 21.
 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The surfaces a link is written on, by theme. */
const SURFACES = {
  light: ['color-background', 'color-note'],
  dark: ['color-background'],
} as const;

describe('a link written in content', () => {
  it.each(Object.keys(THEMES) as (keyof typeof THEMES)[])('reads at 4.5:1 on what it is written on in the %s theme', (name) => {
    const theme = THEMES[name];
    const link = literal(theme, 'color-content-link');
    const short = SURFACES[name]
      .map((surface) => [surface, Number(contrast(link, literal(theme, surface)).toFixed(2))] as const)
      .filter(([, ratio]) => ratio < AA_BODY);
    expect(short).toEqual([]);
  });
});
