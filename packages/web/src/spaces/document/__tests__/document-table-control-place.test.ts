// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A6 and A11: where the cell button and the column handle go, so
 * the two never land on each other (WCAG 2.2 SC 2.5.8: a target under 24px
 * keeps a 24px circle around it clear of every other target).
 */

import { describe, expect, it } from 'vitest';

import {
  cellButtonBox,
  columnHandleCentre,
  rowHandleDrop,
  type Box,
} from '@web/spaces/document/document-table-control-place';

/**
 * A box from its edges.
 * @param left - Left edge.
 * @param top - Top edge.
 * @param right - Right edge.
 * @param bottom - Bottom edge.
 * @returns The box.
 */
function box(left: number, top: number, right: number, bottom: number): Box {
  return { left, top, right, bottom };
}

/**
 * Whether two boxes keep the clearance SC 2.5.8 asks of targets under 24px.
 * @param a - One target.
 * @param b - The other.
 * @returns Whether the circles around them clear both.
 */
function spaced(a: Box, b: Box): boolean {
  const toBox = (x: number, y: number, t: Box): number =>
    Math.hypot(Math.max(t.left - x, 0, x - t.right), Math.max(t.top - y, 0, y - t.bottom));
  const ca = { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 };
  const cb = { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
  return toBox(ca.x, ca.y, b) >= 12 && toBox(cb.x, cb.y, a) >= 12 && Math.hypot(ca.x - cb.x, ca.y - cb.y) >= 24;
}

describe('the cell button box', () => {
  it('sits on the top-right corner of the part of the cell in view', () => {
    expect(cellButtonBox(box(100, 40, 220, 75))).toEqual(box(198, 42, 218, 62));
  });

  it('is not there when the part in view has no room for it', () => {
    expect(cellButtonBox(box(100, 40, 123, 75))).toBeNull();
    expect(cellButtonBox(box(100, 40, 220, 63))).toBeNull();
  });
});

describe('the column handle', () => {
  const line = 40;
  /**
   * The handle's box for a centre.
   * @param x - Its centre.
   * @returns The box.
   */
  const handleAt = (x: number): Box => box(x - 12, line - 6, x + 12, line + 6);

  it('is centred on the part of its cell in view when nothing is near', () => {
    expect(columnHandleCentre(box(100, 40, 220, 75), line, null)).toBe(160);
  });

  it('is not there when the part in view is narrower than the handle', () => {
    expect(columnHandleCentre(box(100, 40, 123, 75), line, null)).toBeNull();
  });

  it('stays centred on a wide first-row cell whose button is far enough away', () => {
    const visible = box(100, 40, 220, 75);
    const button = cellButtonBox(visible)!;
    const x = columnHandleCentre(visible, line, button)!;
    expect(x).toBe(160);
    expect(spaced(handleAt(x), button)).toBe(true);
  });

  it('moves left of the button on a narrow first-row cell, clear of it', () => {
    const visible = box(100, 40, 160, 75);
    const button = cellButtonBox(visible)!;
    const x = columnHandleCentre(visible, line, button)!;
    expect(x).toBeLessThan(130);
    expect(x - 12).toBeGreaterThanOrEqual(100);
    expect(spaced(handleAt(x), button)).toBe(true);
  });

  it('is not there when the first-row cell in view cannot hold both apart', () => {
    const visible = box(100, 40, 145, 75);
    expect(columnHandleCentre(visible, line, cellButtonBox(visible))).toBeNull();
  });

  it('stays centred when the button is on a row further down', () => {
    const visible = box(100, 40, 145, 75);
    const below = cellButtonBox(box(100, 75, 145, 110));
    expect(columnHandleCentre(visible, line, below)).toBe(122.5);
  });
});

describe('the row handle stands beside its row\'s first line (inner#1278)', () => {
  it('moves up from the middle of a tall row to its first line', () => {
    // Measured 2026-10-06: a row 283px tall from 100, the first line of its
    // first cell 108 → 127. The library centres the handle on the row, at 241.5.
    expect(rowHandleDrop({ top: 108, height: 19 }, { top: 100, height: 283 })).toBe(117.5 - 241.5);
  });

  it('barely moves on a one-line row', () => {
    expect(rowHandleDrop({ top: 108, height: 19 }, { top: 100, height: 37 })).toBe(-1);
  });

  it('stays put while the row shows no line', () => {
    expect(rowHandleDrop(undefined, { top: 100, height: 283 })).toBe(0);
  });
});
