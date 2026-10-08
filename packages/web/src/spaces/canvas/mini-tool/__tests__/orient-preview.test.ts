// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { orientPreviewTransform } from '@web/spaces/canvas/mini-tool/orient-preview';

// inner#888 A10 / §7.4: the node previews the result; a quarter turn shrinks
// the picture so all of it stays inside the card.
describe('orientPreviewTransform', () => {
  it('leaves an upright picture untouched', () => {
    expect(orientPreviewTransform({ turns: 0, flipX: false, flipY: false }, 1600, 1000)).toBeUndefined();
  });

  it('turns and shrinks a quarter-turned picture to fit', () => {
    expect(orientPreviewTransform({ turns: 1, flipX: false, flipY: false }, 1600, 1000)).toBe(
      'scale(1, 1) rotate(90deg) scale(0.625)',
    );
  });

  // A flip mirrors along the screen axis its icon shows, whatever turn came
  // before: CSS applies the rightmost function first, so the mirror is last.
  it('mirrors left to right on screen after a quarter turn', () => {
    expect(orientPreviewTransform({ turns: 1, flipX: true, flipY: false }, 1600, 1000)).toBe(
      'scale(-1, 1) rotate(90deg) scale(0.625)',
    );
  });

  it('flips without shrinking on a half turn', () => {
    expect(orientPreviewTransform({ turns: 2, flipX: true, flipY: false }, 1600, 1000)).toBe(
      'scale(-1, 1) rotate(180deg) scale(1)',
    );
  });
});
