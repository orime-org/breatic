// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  GROUP_BACKGROUND_OPTIONS,
  groupBackgroundStyle,
} from '@web/spaces/canvas/group-background';

describe('GROUP_BACKGROUND_OPTIONS — the group tint palette', () => {
  it('leads with 无色 (undefined) then the 4 status tokens', () => {
    expect(GROUP_BACKGROUND_OPTIONS.map((o) => o.value)).toEqual([
      undefined,
      '--color-status-info-bg',
      '--color-status-success-bg',
      '--color-status-warning-bg',
      '--color-status-error-bg',
    ]);
  });

  it('excludes the selected (identity) status color — it is not a tint', () => {
    expect(
      GROUP_BACKGROUND_OPTIONS.some((o) => o.value === '--color-status-selected-bg'),
    ).toBe(false);
  });

  it('gives every option an i18n label key', () => {
    for (const opt of GROUP_BACKGROUND_OPTIONS) {
      expect(opt.labelKey).toMatch(/^canvas\.group\./);
    }
  });
});

describe('groupBackgroundStyle — stored token → CSS color', () => {
  it('wraps a stored token name in var()', () => {
    expect(groupBackgroundStyle('--color-status-info-bg')).toBe(
      'var(--color-status-info-bg)',
    );
  });

  it('returns undefined for 无色 (no stored token)', () => {
    expect(groupBackgroundStyle(undefined)).toBeUndefined();
  });
});
