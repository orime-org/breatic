// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The words under a comment highlight stay readable (#18, A6 · A20 · A24).
 *
 * A highlight paints a colour behind body text, and the deeper shade a read
 * thread carries paints a second layer over the first. Two overlapping
 * threads add a third. Every one of those states is somewhere a reader is
 * taken by an acceptance item — hovering a card, pressing a highlight,
 * pressing the stretch two comments share — so each has to clear WCAG 2.2
 * SC 1.4.3, 4.5:1 for body text.
 *
 * Tokens rather than the screen: the alpha values and the hue are what
 * decide this, and a measurement here catches a change to either one at the
 * moment it is made.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

const css = readFileSync(
  resolve(import.meta.dirname, '../../../theme/tokens.css'),
  'utf8',
);

/** WCAG 2.2 SC 1.4.3, body text. */
const AA_BODY = 4.5;

/** One colour, as the three channels a ratio is computed from. */
type Rgb = readonly [number, number, number];

/**
 * Reads a `#rrggbb` literal.
 * @param hex - The literal, with its hash.
 * @returns Its channels.
 */
function rgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The relative luminance WCAG defines.
 * @param colour - The colour to weigh.
 * @returns Its luminance, 0 to 1.
 */
function luminance(colour: Rgb): number {
  const [r, g, b] = colour.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as unknown as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The contrast between two colours, as WCAG states it.
 * @param a - One colour.
 * @param b - The other.
 * @returns The ratio, 1 to 21.
 */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * One colour laid over another at some alpha.
 * @param over - The colour on top.
 * @param alpha - How much of it shows.
 * @param under - What it covers.
 * @returns The colour that results.
 */
function layer(over: Rgb, alpha: number, under: Rgb): Rgb {
  return under.map((u, at) => alpha * over[at]! + (1 - alpha) * u) as unknown as Rgb;
}

/**
 * The alpha of several layers of one colour, stacked.
 * @param alphas - Each layer's alpha.
 * @returns The alpha they come to together.
 */
function stacked(...alphas: number[]): number {
  return 1 - alphas.reduce((left, a) => left * (1 - a), 1);
}

/**
 * A custom property's value, from the last block that sets it.
 * @param name - The property, without its dashes.
 * @param after - Only look past this marker, for a theme's own block.
 * @returns The value as written.
 */
function token(name: string, after = ''): string {
  const from = after === '' ? 0 : css.indexOf(after);
  const found = [
    ...css.slice(from).matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g')),
  ];
  return found.at(-1)![1]!.trim();
}

/**
 * The percentage a `color-mix` shows of its first colour.
 * @param value - The declaration's value.
 * @returns That percentage as a fraction.
 */
function mixAlpha(value: string): number {
  return Number(/(\d+(?:\.\d+)?)%/.exec(value)![1]) / 100;
}

const DARK_BLOCK = 'html[data-theme=\'dark\']';

describe('the words under a comment highlight', () => {
  it('stay readable in the dark theme, through every layer', () => {
    const hue = rgb(token('color-comment-hue', DARK_BLOCK));
    const ground = rgb(token('color-background', DARK_BLOCK));
    const text = rgb(token('neutral-900', DARK_BLOCK));
    const mark = mixAlpha(token('color-comment-mark', DARK_BLOCK));
    const active = mixAlpha(token('color-comment-mark-active', DARK_BLOCK));

    const states = {
      plain: stacked(mark),
      overlapping: stacked(mark, mark),
      read: stacked(mark, active),
      overlappingAndRead: stacked(mark, mark, active),
    };

    const measured = Object.fromEntries(
      Object.entries(states).map(([name, alpha]) => [
        name,
        Number(contrast(text, layer(hue, alpha, ground)).toFixed(2)),
      ]),
    );

    expect(
      Object.entries(measured).filter(([, ratio]) => ratio < AA_BODY),
    ).toEqual([]);
  });

  it('stay readable in the light theme, through every layer', () => {
    const hue = rgb(token('color-comment-hue'));
    const ground = rgb('#f0f0f0');
    const text = rgb('#1e1e1e');
    const mark = mixAlpha(token('color-comment-mark'));
    const active = mixAlpha(token('color-comment-mark-active'));

    const worst = contrast(
      text,
      layer(hue, stacked(mark, mark, active), ground),
    );

    expect(worst).toBeGreaterThanOrEqual(AA_BODY);
  });
});
