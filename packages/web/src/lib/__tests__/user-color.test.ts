// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { userPaletteColor } from '@web/lib/user-color';

// Collaborator identity color (batch-2 item 14): a user's caret color is a
// pure function of their user id — every client derives the SAME color for
// the same collaborator with zero coordination, and it never changes across
// sessions. Values are palette-token var() references so the color adapts to
// light/dark via the token's own two-mode values (classification/identity
// colors are hand-tuned per mode — no contrast math, user 2026-07-03).
describe('userPaletteColor — deterministic user id → palette identity color', () => {
  const VALID = [
    'var(--color-palette-red)',
    'var(--color-palette-orange)',
    'var(--color-palette-green)',
    'var(--color-palette-blue)',
    'var(--color-palette-violet)',
    'var(--color-palette-pink)',
    'var(--color-palette-teal)',
  ];

  it('always returns one of the 7 palette token references', () => {
    for (const id of ['u-1', 'u-2', '9d1f...', '', 'ünïcode-用户']) {
      expect(VALID).toContain(userPaletteColor(id));
    }
  });

  it('is deterministic — the same id maps to the same color on every call', () => {
    const id = '1850d253-2360-4687-9c3d-1b8f8462bcb8';
    expect(userPaletteColor(id)).toBe(userPaletteColor(id));
  });

  it('spreads distinct ids across several colors (not everyone the same hue)', () => {
    const colors = new Set(
      Array.from({ length: 40 }, (_, i) => userPaletteColor(`user-${i}`)),
    );
    // FNV-1a over 40 ids must hit well over half the palette; a degenerate
    // hash (everything one bucket) fails loudly here.
    expect(colors.size).toBeGreaterThanOrEqual(4);
  });
});
