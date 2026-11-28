// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';

import { fittingEntryCount } from '@web/spaces/timeline/toolbar-fit';

const GAP = 6;
const MORE = 32;

describe('fittingEntryCount (inner#1709)', () => {
  it('shows every entry and no More when the whole row fits exactly', () => {
    expect(fittingEntryCount([32, 32, 32], 32 * 3 + GAP * 2, GAP, MORE)).toBe(3);
  });

  it('keeps room for More once one entry does not fit', () => {
    // Two entries and More need 32 + 6 + 32 + 6 + 32 = 108.
    expect(fittingEntryCount([32, 32, 32], 32 * 3 + GAP * 2 - 1, GAP, MORE)).toBe(1);
    expect(fittingEntryCount([32, 32, 32, 32], 108, GAP, MORE)).toBe(2);
  });

  it('counts each entry at its own width, separators and the zoom slider included', () => {
    const widths = [32, 47, 32, 158];
    expect(fittingEntryCount(widths, 32 + GAP + 47 + GAP + 32 + GAP + MORE, GAP, MORE)).toBe(3);
    expect(fittingEntryCount(widths, 32 + GAP + 47 + GAP + 32 + GAP + 158, GAP, MORE)).toBe(4);
  });

  it('shows only More when not even the first entry fits beside it, and nothing narrower than More', () => {
    expect(fittingEntryCount([32, 32], MORE + GAP + 31, GAP, MORE)).toBe(0);
    expect(fittingEntryCount([32, 32], MORE - 1, GAP, MORE)).toBe(0);
  });

  it('shows nothing for an empty toolbar', () => {
    expect(fittingEntryCount([], 500, GAP, MORE)).toBe(0);
  });
});
