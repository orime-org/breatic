// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The words on a sticky stay readable on the note's own ground, in both
 * themes.
 *
 * `bg-note` exists for this feature and nothing else, so what goes on top of
 * it is this feature's to get right. The body was never in question; what a
 * real board caught is the recessive half — the time, the "edited" mark, the
 * drop notice, and the placeholder in every box — which the note inherited
 * from the page's `--color-muted-foreground`. That token is tuned against
 * `--color-background`, and the note is a different ground: dark measured
 * 4.31:1 against the 4.5 floor (WCAG 2.2 SC 1.4.3 AA, and every one of those
 * is 11px regular, so the large-text exemption does not reach them).
 *
 * Both sides are read from the files that ship: the values out of
 * `tokens.css`, the class out of the components. A test carrying its own copy
 * of either would go on passing after the thing it guards moved.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../../..');
const TOKENS = fs.readFileSync(
  path.join(ROOT, 'src/theme/tokens.css'),
  'utf8',
);

/** The two grounds a reader ever sees a note on. */
type Theme = 'light' | 'dark';

/**
 * Every custom property declared for one theme, in source order.
 *
 * Light is the `:root` block; dark is the `html[data-theme='dark']` block,
 * which redefines the neutral scale on top of it — so dark is read as light
 * first and then overlaid, the same way the cascade resolves it.
 * @param theme - Which block to read.
 * @returns Property name to declared value, unresolved.
 * @throws {Error} When the dark block is not in the file.
 */
function declarations(theme: Theme): Map<string, string> {
  // The selector where a line begins: the file's own header comment names it
  // too, and cutting there leaves the light block empty.
  const dark = /^html\[data-theme='dark'\]/m.exec(TOKENS)?.index;
  if (dark === undefined) throw new Error('no dark block in tokens.css');
  const source = theme === 'light' ? TOKENS.slice(0, dark) : TOKENS;
  const out = new Map<string, string>();
  for (const [, name, value] of source.matchAll(
    /(--[a-z0-9-]+)\s*:\s*([^;]+);/g,
  )) {
    out.set(name, value.trim());
  }
  return out;
}

/**
 * Follow a token through its `var()` chain to the colour it lands on.
 * @param name - The custom property to resolve.
 * @param theme - Which theme to resolve it in.
 * @returns The hex value, lowercased.
 * @throws {Error} When the chain does not end at a hex colour.
 */
function resolve(name: string, theme: Theme): string {
  const all = declarations(theme);
  let value = all.get(name);
  for (let hop = 0; hop < 8 && value !== undefined; hop += 1) {
    const hex = /^#[0-9a-f]{6}$/i.exec(value.trim());
    if (hex) return value.trim().toLowerCase();
    const chained = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
    if (!chained) break;
    value = all.get(chained[1] as string);
  }
  throw new Error(`${name} does not resolve to a hex colour in ${theme}`);
}

/**
 * One channel of a hex colour, linearised.
 * @param channel - The channel byte, 0 to 255.
 * @returns Its linear-light value.
 */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The relative luminance of a hex colour ([WCAG 2.2, relative
 * luminance](https://www.w3.org/TR/WCAG22/#dfn-relative-luminance)).
 * @param hex - A six-digit hex colour.
 * @returns Its relative luminance.
 */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * linear((n >> 16) & 255) +
    0.7152 * linear((n >> 8) & 255) +
    0.0722 * linear(n & 255)
  );
}

/**
 * The contrast ratio between two hex colours.
 * @param a - One colour.
 * @param b - The other.
 * @returns The ratio, at least 1.
 */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** What WCAG 2.2 SC 1.4.3 asks of text below 24px at a normal weight. */
const BODY_FLOOR = 4.5;

/**
 * A source file under `packages/web/src`.
 * @param rel - Its path from `src`.
 * @returns The file's text.
 */
const source = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');

describe('what a sticky says, on the note it says it on', () => {
  for (const theme of ['light', 'dark'] as Theme[]) {
    it(`keeps the body above the floor in ${theme}`, () => {
      expect(
        contrast(resolve('--color-note-foreground', theme), resolve('--color-note', theme)),
      ).toBeGreaterThanOrEqual(BODY_FLOOR);
    });

    it(`keeps the recessive words above the floor in ${theme}`, () => {
      // The time, the "edited" mark, the drop notice and every placeholder.
      expect(
        contrast(
          resolve('--color-note-foreground-muted', theme),
          resolve('--color-note', theme),
        ),
      ).toBeGreaterThanOrEqual(BODY_FLOOR);
    });
  }

  it('sends every recessive word on the note through that token', () => {
    // The page-wide `--color-muted-foreground` is tuned against
    // `--color-background`; on the note it lands at 4.31 in dark. Guarding
    // only the token's value would leave the ratio right and the class
    // pointing somewhere else.
    const onTheNote = [
      'spaces/canvas/annotation/AnnotationEntry.tsx',
      'spaces/canvas/annotation/AnnotationSticky.tsx',
      'spaces/canvas/annotation/AnnotationComposer.tsx',
      'spaces/canvas/annotation/caps.ts',
    ];
    for (const file of onTheNote) {
      expect(source(file), file).not.toContain('text-muted-foreground');
      expect(source(file), file).not.toContain(
        'placeholder:text-muted-foreground',
      );
    }
  });

  it('gives every box on a sticky the note placeholder', () => {
    // All three boxes take their shape from one constant, so the placeholder
    // is set once rather than on each of them.
    expect(source('spaces/canvas/annotation/caps.ts')).toContain(
      'placeholder:text-note-foreground-muted',
    );
  });
});
