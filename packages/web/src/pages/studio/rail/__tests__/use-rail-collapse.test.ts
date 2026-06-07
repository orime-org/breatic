// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useRailCollapse } from '@web/pages/studio/rail/use-rail-collapse';

describe('useRailCollapse (rail ④⑤ collapse persist — spec §4.4)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to expanded (not collapsed)', () => {
    const { result } = renderHook(() => useRailCollapse('rail.myStudios'));
    expect(result.current.collapsed).toBe(false);
  });

  it('toggles and persists the choice to localStorage', () => {
    const { result } = renderHook(() => useRailCollapse('rail.myStudios'));

    act(() => result.current.toggle());

    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem('rail.myStudios')).toBe('1');
  });

  it('reads the persisted collapsed state on a fresh mount (cross-session)', () => {
    window.localStorage.setItem('rail.joined', '1');

    const { result } = renderHook(() => useRailCollapse('rail.joined'));

    expect(result.current.collapsed).toBe(true);
  });
});
