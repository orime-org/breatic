// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The band every 40px chrome bar occupies.
 *
 * Three bars sit on the same line or directly above one another -- the top
 * bar, the agent column's header and the space tab bar -- and each carries a
 * 1px rule along its bottom. The rule lives inside the 40, so centring
 * against what is left of them puts the contents half a pixel above the
 * middle of the band a reader sees. Balancing it in one bar and not the
 * others is what pulls two of them out of line with each other, so the box
 * is stated once and the three read it.
 */

import { describe, it, expect } from 'vitest';

import { chromeBarBox } from '@web/pages/project/chrome/bar-box';

describe('the box a chrome bar occupies', () => {
  it('balances the rule along its bottom with a pixel on top', () => {
    const box = chromeBarBox('var(--space-4)', 'var(--space-2)');

    expect(box.height).toBe(40);
    expect(box.padding).toBe('1px var(--space-4) 0');
  });

  it('leaves the sides and the gap to the bar asking for it', () => {
    const box = chromeBarBox('var(--space-5)', 'var(--space-4)');

    expect(box.padding).toBe('1px var(--space-5) 0');
    expect(box.gap).toBe('var(--space-4)');
  });
});
