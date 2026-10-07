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
      'rotate(90deg) scale(0.625) scale(1, 1)',
    );
  });

  it('flips without shrinking on a half turn', () => {
    expect(orientPreviewTransform({ turns: 2, flipX: true, flipY: false }, 1600, 1000)).toBe(
      'rotate(180deg) scale(1) scale(-1, 1)',
    );
  });
});
