// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { readStoredTheme, usePreferencesStore } from '@web/stores/preferences';

const KEY = 'breatic.theme';

describe('usePreferencesStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePreferencesStore.setState({ theme: 'light' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setTheme changes theme', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(usePreferencesStore.getState().theme).toBe('dark');
  });

  it('stores the theme as the plain value', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(window.localStorage.getItem(KEY)).toBe('dark');
  });

  it.each(['dark', 'light', 'system'] as const)('reads a stored %s back', (theme) => {
    window.localStorage.setItem(KEY, theme);
    expect(readStoredTheme()).toBe(theme);
  });

  it.each([null, 'blue', '{"state":{"theme":"dark"},"version":1}'])(
    'reads %s as system',
    (value) => {
      if (value !== null) window.localStorage.setItem(KEY, value);
      expect(readStoredTheme()).toBe('system');
    },
  );

  it('falls back to system and keeps working when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readStoredTheme()).toBe('system');
    expect(() => usePreferencesStore.getState().setTheme('dark')).not.toThrow();
    expect(usePreferencesStore.getState().theme).toBe('dark');
  });

  it('does not write the old persisted envelope', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(window.localStorage.getItem('breatic.preferences')).toBeNull();
  });
});
