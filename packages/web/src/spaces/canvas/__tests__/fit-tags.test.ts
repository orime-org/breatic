// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it } from 'vitest';

import { countTagsThatFit } from '@web/spaces/canvas/fit-tags';

/** The gap between two tags, in px. */
const GAP = 4;
/** What the `+N` badge takes, in px. */
const BADGE = 24;

describe('countTagsThatFit', () => {
  it('keeps every tag when they all fit', () => {
    expect(countTagsThatFit([40, 40, 40], BADGE, 256, GAP)).toBe(3);
  });

  it('keeps every tag when they fill the row exactly', () => {
    // 100 + 4 + 100 = 204. No badge is needed, so the badge width is not
    // subtracted from a row that already holds everything.
    expect(countTagsThatFit([100, 100], BADGE, 204, GAP)).toBe(2);
  });

  it('leaves room for the badge once something has to drop', () => {
    // Three 100s need 308 and the row holds 256. Two of them plus the gap and
    // the badge is 100 + 4 + 100 + 4 + 24 = 232, which fits.
    expect(countTagsThatFit([100, 100, 100], BADGE, 256, GAP)).toBe(2);
  });

  it('drops to one when two plus the badge would overflow', () => {
    // 100 + 4 + 100 + 4 + 24 = 232 against a 200 row: only the first survives.
    expect(countTagsThatFit([100, 100, 100], BADGE, 200, GAP)).toBe(1);
  });

  it('shows the badge alone when not even one tag fits beside it', () => {
    // The count and the badge together still say how many people are there.
    expect(countTagsThatFit([100, 100], BADGE, 60, GAP)).toBe(0);
  });

  it('handles a single tag that is too wide on its own', () => {
    // One person, one tag: it is the whole truth, so it stays and is left to
    // the ellipsis rather than being replaced by a badge saying "+1".
    expect(countTagsThatFit([400], BADGE, 256, GAP)).toBe(1);
  });

  it('handles an empty row', () => {
    expect(countTagsThatFit([], BADGE, 256, GAP)).toBe(0);
  });

  it('counts the gap when deciding the whole row fits', () => {
    // 100 + 4 + 100 = 204 against a 202 row: the pair does not fit, so one
    // drops and the badge appears. Measuring the row without its gap would
    // read 200, call it a fit, and draw two tags wider than the row.
    expect(countTagsThatFit([100, 100], BADGE, 202, GAP)).toBe(1);
  });

  it('counts the gap between neighbours', () => {
    // Two 100s plus their gap and the badge is 100 + 4 + 100 + 4 + 24 = 232,
    // over this row. Forgetting the gap between them would read 228 and let a
    // second tag in that does not physically fit.
    expect(countTagsThatFit([100, 100, 100], BADGE, 230, GAP)).toBe(1);
  });

  it('counts widths that differ', () => {
    // 30 + 4 + 200 = 234 fits; adding the third needs 234 + 4 + 30 = 268.
    // Keeping two plus the badge is 234 + 4 + 24 = 262, over 256 — so one.
    expect(countTagsThatFit([30, 200, 30], BADGE, 256, GAP)).toBe(1);
  });
});
