// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  GROUP_BACKGROUND_OPTIONS,
  LEGACY_GROUP_BACKGROUND_ALIASES,
  normalizeGroupBackground,
  groupBackgroundStyle,
  groupBorderStyle,
  groupSwatchStyle,
} from '@web/spaces/canvas/group-background';

describe('GROUP_BACKGROUND_OPTIONS — the 7-color palette tints (#1549)', () => {
  it('leads with 无色 (undefined) then the 7 palette tints in spec order', () => {
    expect(GROUP_BACKGROUND_OPTIONS.map((o) => o.value)).toEqual([
      undefined,
      '--color-palette-red-bg',
      '--color-palette-orange-bg',
      '--color-palette-green-bg',
      '--color-palette-blue-bg',
      '--color-palette-violet-bg',
      '--color-palette-pink-bg',
      '--color-palette-teal-bg',
    ]);
  });

  it('keys options by plain color name (name = identity, no semantics)', () => {
    expect(GROUP_BACKGROUND_OPTIONS.map((o) => o.key)).toEqual([
      'none',
      'red',
      'orange',
      'green',
      'blue',
      'violet',
      'pink',
      'teal',
    ]);
  });

  it('gives every option an i18n label key', () => {
    for (const opt of GROUP_BACKGROUND_OPTIONS) {
      expect(opt.labelKey).toMatch(/^canvas\.group\./);
    }
  });
});

describe('LEGACY_GROUP_BACKGROUND_ALIASES — stored status tokens map to palette (#1549 zero migration)', () => {
  it('maps each of the 4 legacy status tints to its palette successor', () => {
    expect(LEGACY_GROUP_BACKGROUND_ALIASES).toEqual({
      '--color-status-info-bg': '--color-palette-blue-bg',
      '--color-status-success-bg': '--color-palette-green-bg',
      '--color-status-warning-bg': '--color-palette-orange-bg',
      '--color-status-error-bg': '--color-palette-red-bg',
    });
  });
});

describe('normalizeGroupBackground — legacy stored values resolve to current tokens', () => {
  it('rewrites a legacy status token to its palette token', () => {
    expect(normalizeGroupBackground('--color-status-info-bg')).toBe(
      '--color-palette-blue-bg',
    );
  });

  it('passes current palette tokens through unchanged', () => {
    expect(normalizeGroupBackground('--color-palette-teal-bg')).toBe(
      '--color-palette-teal-bg',
    );
  });

  it('passes 无色 (undefined) through', () => {
    expect(normalizeGroupBackground(undefined)).toBeUndefined();
  });
});

describe('groupBackgroundStyle — stored token → CSS color', () => {
  it('wraps a stored palette token in var()', () => {
    expect(groupBackgroundStyle('--color-palette-blue-bg')).toBe(
      'var(--color-palette-blue-bg)',
    );
  });

  it('normalizes a legacy status token before wrapping (old groups render the new color)', () => {
    expect(groupBackgroundStyle('--color-status-info-bg')).toBe(
      'var(--color-palette-blue-bg)',
    );
  });

  it('returns undefined for 无色 (no stored token)', () => {
    expect(groupBackgroundStyle(undefined)).toBeUndefined();
  });
});

describe('groupBorderStyle — tinted groups get the matching 40% border (#1549 dark-mode anchor)', () => {
  it('derives the -border sibling from the -bg token', () => {
    expect(groupBorderStyle('--color-palette-red-bg')).toBe(
      'var(--color-palette-red-border)',
    );
  });

  it('normalizes legacy values first', () => {
    expect(groupBorderStyle('--color-status-info-bg')).toBe(
      'var(--color-palette-blue-border)',
    );
  });

  it('returns undefined for 无色 (untinted groups keep the neutral dashed border)', () => {
    expect(groupBorderStyle(undefined)).toBeUndefined();
  });
});

describe('groupSwatchStyle — picker dots use the solid identity color (Chrome model)', () => {
  it('derives the identity color from the -bg token', () => {
    expect(groupSwatchStyle('--color-palette-violet-bg')).toBe(
      'var(--color-palette-violet)',
    );
  });

  it('normalizes legacy values first', () => {
    expect(groupSwatchStyle('--color-status-error-bg')).toBe(
      'var(--color-palette-red)',
    );
  });

  it('returns undefined for 无色', () => {
    expect(groupSwatchStyle(undefined)).toBeUndefined();
  });
});
