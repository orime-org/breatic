// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #964: a list's marker and a heading's number are told apart from the words.
 *
 * What is read here is the pair of properties that carry the whole of it — the
 * colour, and the figures' width — and one relation that had been written as a
 * second copy of a number declared elsewhere.
 *
 * The reason these are read off the stylesheet: taking the colour out and
 * taking the tabular figures out are each exactly the defect that was
 * reported, and with them out the whole unit suite stayed green (measured
 * 2026-09-10, 953 cases). The browser smoke does hold them, and it skips every
 * case with no credentials in the environment while exiting 0.
 */

import { describe, it, expect } from 'vitest';

import { ruleBody } from '@web/spaces/document/__tests__/index-css-rules';

/** The number a heading or an ordered item draws, markers' shared rule. */
const NUMBER = '.bn-block-content[data-doc-number]::before';

/** The box a bullet's shape is painted in. */
const BULLET = '.bn-block-content[data-bullet-level]::before';

describe('what tells a marker apart from the words', () => {
  it('draws every number in the palette blue', () => {
    // The identity value doubles as the coloured-TEXT colour, which is what
    // `theme/tokens.css` says of the palette and what this needs. Taken out,
    // the number inherits the body's foreground and is the state the reader
    // reported.
    expect(ruleBody(NUMBER)).toContain('color: var(--color-palette-blue)');
  });

  it('draws every number in figures of one width', () => {
    // Inter's digits are proportional by default, so `1.` measured 18.4px
    // against `2.`'s 21.5px and the text beside them started at two different
    // x's down one list (user 2026-09-08).
    expect(ruleBody(NUMBER)).toContain('font-variant-numeric: tabular-nums');
  });

  it('draws every bullet in the same blue, through `currentcolor`', () => {
    // The three shapes are gradients painted in `currentcolor`, so the colour
    // on the box is what reaches them.
    expect(ruleBody(BULLET)).toContain('color: var(--color-palette-blue)');
  });

  it('gives a bullet a box of one line box, not a second copy of the line-height', () => {
    // `1lh` IS the line box of whatever block the marker sits on. A multiple of
    // `em` is the body's line-height written a second time, and the two drifted:
    // at 15px, `1.5em` gave the box 22.5px against the words' 1.65 line box of
    // 24.75px, and `background-position: center` then put all three shapes
    // 1.125px above the glyphs they label.
    expect(ruleBody(BULLET)).toContain('height: 1lh');
  });
});
