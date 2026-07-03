// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { minimapNodeColor } from '@web/spaces/canvas/minimap-node-color';

describe('minimapNodeColor — MiniMap node fill from the 7-color palette (#1548)', () => {
  it.each([
    ['text', 'var(--color-palette-blue)'],
    ['image', 'var(--color-palette-green)'],
    ['audio', 'var(--color-palette-pink)'],
    ['video', 'var(--color-palette-violet)'],
    ['annotation', 'var(--color-palette-orange)'],
  ])('%s nodes paint the ratified palette identity', (type, expected) => {
    expect(minimapNodeColor({ type, data: {} })).toBe(expected);
  });

  it('tinted groups paint their own background tint', () => {
    expect(
      minimapNodeColor({
        type: 'group',
        data: { backgroundColor: '--color-palette-teal-bg' },
      }),
    ).toBe('var(--color-palette-teal-bg)');
  });

  it('legacy stored group tints normalize to the palette successor', () => {
    expect(
      minimapNodeColor({
        type: 'group',
        data: { backgroundColor: '--color-status-info-bg' },
      }),
    ).toBe('var(--color-palette-blue-bg)');
  });

  it('untinted groups fall back to the neutral fill', () => {
    expect(minimapNodeColor({ type: 'group', data: {} })).toBe(
      'var(--color-muted)',
    );
  });

  it.each([['red'], ['#ff0000'], ['--evil-token'], ['url(javascript:1)']])(
    'corrupt/hostile stored group tint %s falls back to neutral instead of a dropped-fill BLACK rect (adversarial finding)',
    (stored) => {
      expect(
        minimapNodeColor({ type: 'group', data: { backgroundColor: stored } }),
      ).toBe('var(--color-muted)');
    },
  );

  it('non-string stored group tint (Yjs corruption) falls back to neutral', () => {
    expect(
      minimapNodeColor({ type: 'group', data: { backgroundColor: 42 } }),
    ).toBe('var(--color-muted)');
  });

  it.each([['3d'], ['web'], ['unknown-kind'], [undefined]])(
    'unmapped kind %s falls back to the neutral fill (reserved kinds have no creation entry today)',
    (type) => {
      expect(minimapNodeColor({ type, data: {} })).toBe('var(--color-muted)');
    },
  );
});
