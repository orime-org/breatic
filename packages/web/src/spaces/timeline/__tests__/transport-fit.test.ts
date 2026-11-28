// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';

import { nextTransportForm } from '@web/spaces/timeline/transport-fit';

// Widths of the six forms of the control row, widest first.
const WIDTHS = [389, 299, 253, 173, 98, 56];

describe('nextTransportForm (inner#1709)', () => {
  it('keeps the full form while it fits, exactly at its width too', () => {
    expect(nextTransportForm(0, WIDTHS, 389)).toBe(0);
    expect(nextTransportForm(0, [389], 1000)).toBe(0);
  });

  it('steps to the next form while the shown one does not fit', () => {
    expect(nextTransportForm(0, WIDTHS, 388)).toBe(1);
    expect(nextTransportForm(1, WIDTHS, 298)).toBe(2);
    expect(nextTransportForm(2, WIDTHS, 252)).toBe(3);
    expect(nextTransportForm(3, WIDTHS, 172)).toBe(4);
    expect(nextTransportForm(4, WIDTHS, 97)).toBe(5);
  });

  it('stays on the last form when even it does not fit', () => {
    expect(nextTransportForm(5, WIDTHS, 10)).toBe(5);
  });

  it('steps back to the wider form once it fits again, and stays when it does not', () => {
    expect(nextTransportForm(5, WIDTHS, 98)).toBe(4);
    expect(nextTransportForm(3, WIDTHS, 253)).toBe(2);
    expect(nextTransportForm(2, WIDTHS, 299)).toBe(1);
    expect(nextTransportForm(2, WIDTHS, 298)).toBe(2);
  });

  it('tries a wider form whose width is not known yet', () => {
    expect(nextTransportForm(2, [undefined, undefined, 253], 1000)).toBe(1);
  });

  it('waits for the shown form to be measured', () => {
    expect(nextTransportForm(1, [389], 10)).toBe(1);
  });
});
