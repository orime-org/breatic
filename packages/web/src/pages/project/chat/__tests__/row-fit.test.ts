// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a row of squares divides the room it has.
 *
 * The row holds a fixed number of slots and the squares take whatever that
 * leaves, so the picture is as large as the column allows rather than as large
 * as one number written down once. The Agent column runs 320 to 640 and the
 * message list pads it by 12 a side, so a row has 296 to 616 to divide.
 */

import { describe, it, expect } from 'vitest';

import { ROW_SLOTS, planRow } from '@web/pages/project/chat/row-fit';

describe('a row of squares', () => {
  it('gives every asset a slot while there are slots to give', () => {
    const plan = planRow(3, 296, 8);

    expect(plan.shown).toBe(3);
    expect(plan.hidden).toBe(0);
  });

  it('fills the last slot with the button once there are more than slots', () => {
    const plan = planRow(10, 296, 8);

    expect(plan.shown).toBe(ROW_SLOTS - 1);
    expect(plan.hidden).toBe(10 - (ROW_SLOTS - 1));
  });

  it('draws every asset when they come to exactly the slots there are', () => {
    // The boundary the button exists for: at the count that fits, no button.
    const plan = planRow(ROW_SLOTS, 296, 8);

    expect(plan.shown).toBe(ROW_SLOTS);
    expect(plan.hidden).toBe(0);
  });

  it('divides the narrowest column into squares that fill it', () => {
    const plan = planRow(10, 296, 8);

    // Four slots and three gaps: 4 * 68 + 3 * 8 = 296.
    expect(plan.sizePx).toBe(68);
    expect(plan.sizePx * ROW_SLOTS + 8 * (ROW_SLOTS - 1)).toBe(296);
  });

  it('grows the squares with the column rather than drawing more of them', () => {
    const wide = planRow(20, 616, 8);

    expect(wide.sizePx).toBe(148);
    expect(wide.shown).toBe(ROW_SLOTS - 1);
  });

  it('never asks for a fraction of a pixel', () => {
    const plan = planRow(10, 301, 8);

    expect(Number.isInteger(plan.sizePx)).toBe(true);
    // Rounded down, so the row stays inside the room it was given.
    expect(plan.sizePx * ROW_SLOTS + 8 * (ROW_SLOTS - 1)).toBeLessThanOrEqual(301);
  });

  it('draws the first frame at the narrowest a column can be, before anything is measured', () => {
    // `useRowMeasure` reports 0 until the layout effect runs. The first frame
    // has to draw something, and the size it draws must be one the row will
    // certainly have room for.
    const unmeasured = planRow(10, 0, 8);

    expect(unmeasured.sizePx).toBe(68);
  });

  it('answers with nothing to draw when the turn found nothing', () => {
    const plan = planRow(0, 296, 8);

    expect(plan.shown).toBe(0);
    expect(plan.hidden).toBe(0);
  });
});
