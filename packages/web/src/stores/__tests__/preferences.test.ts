// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { usePreferencesStore } from '@web/stores/preferences';

describe('usePreferencesStore', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ theme: 'light' });
  });

  it('initial defaults', () => {
    const s = usePreferencesStore.getState();
    expect(s.theme).toBe('light');
  });

  it('setTheme changes theme', () => {
    usePreferencesStore.getState().setTheme('dark');
    expect(usePreferencesStore.getState().theme).toBe('dark');
  });
});
