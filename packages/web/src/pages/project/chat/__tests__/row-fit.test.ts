// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many of a row's items it can show.
 *
 * Both rows a reply can carry -- the sources and what the turn found -- follow
 * one rule: one line, no wrap, no scroll, and what does not fit goes behind a
 * button that opens the rest. The rule is the same for both, so the
 * arithmetic is one function; the squares are all one size and the chips are
 * each their own, which is why it takes the widths rather than a count.
 *
 * A count decided in advance cannot be right at both ends: the Agent column
 * runs 320 to 640, so a row has 296 to 616 to work with. Too many and the row
 * clips them along with the button that reaches the rest; too few and the
 * reader is sent through a dialog for what would have fitted.
 */

import { describe, it, expect } from 'vitest';

import { fitsInRow } from '@web/pages/project/chat/row-fit';

/** 46 见方的方格，n 个。 */
const squares = (n: number): number[] => Array.from({ length: n }, () => 46);

describe('a row of squares', () => {
  it('draws them all when they all fit, with no button to make room for', () => {
    expect(fitsInRow(squares(5), 8, 296, 46)).toBe(5);
  });

  it('gives up one square to the button when they do not', () => {
    expect(fitsInRow(squares(8), 8, 296, 46)).toBe(4);
  });

  it('draws more of them as the column widens', () => {
    expect(fitsInRow(squares(20), 8, 616, 46)).toBe(10);
  });
});

describe('a row of chips, each its own width', () => {
  it('counts the widths it was given rather than assuming one', () => {
    // 60 + 8 + 90 + 8 + 70 = 236，加上间距和 28 的按钮是 272，296 装得下。
    expect(fitsInRow([60, 90, 70, 120], 8, 296, 28)).toBe(3);
  });

  it('stops before the one that would push the button out', () => {
    expect(fitsInRow([200, 200, 200], 8, 296, 28)).toBe(1);
  });

  it('still draws one when even that overflows, rather than an empty row', () => {
    expect(fitsInRow([400, 400], 8, 296, 28)).toBe(1);
  });

  it('draws them all when the button is not needed', () => {
    expect(fitsInRow([60, 90, 70], 8, 296, 28)).toBe(3);
  });
});
