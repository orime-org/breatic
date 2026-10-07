// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useStudioListPrefs } from '@web/pages/studio/container/list-prefs';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useStudioListPrefs', () => {
  it('starts each list on its default sort, in the grid', () => {
    expect(renderHook(() => useStudioListPrefs('s-1', 'projects')).result.current).toMatchObject({
      sort: 'opened',
      view: 'grid',
    });
    expect(renderHook(() => useStudioListPrefs('s-1', 'archived')).result.current).toMatchObject({
      sort: 'archived',
      view: 'grid',
    });
  });

  it('keeps a choice for the next visit to the same studio and list only', () => {
    const first = renderHook(() => useStudioListPrefs('s-1', 'projects'));
    act(() => first.result.current.setSort('name'));
    act(() => first.result.current.setView('list'));
    expect(first.result.current).toMatchObject({ sort: 'name', view: 'list' });

    expect(renderHook(() => useStudioListPrefs('s-1', 'projects')).result.current).toMatchObject({
      sort: 'name',
      view: 'list',
    });
    expect(renderHook(() => useStudioListPrefs('s-2', 'projects')).result.current).toMatchObject({
      sort: 'opened',
      view: 'grid',
    });
    expect(renderHook(() => useStudioListPrefs('s-1', 'archived')).result.current).toMatchObject({
      sort: 'archived',
      view: 'grid',
    });
  });

  it('falls back to the defaults for a stored value the list does not offer', () => {
    window.localStorage.setItem(
      'breatic:studio-list:s-1:archived',
      JSON.stringify({ sort: 'opened', view: 'table' }),
    );
    expect(renderHook(() => useStudioListPrefs('s-1', 'archived')).result.current).toMatchObject({
      sort: 'archived',
      view: 'grid',
    });
  });

  it('still works when the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => useStudioListPrefs('s-1', 'projects'));
    expect(result.current.sort).toBe('opened');
    act(() => result.current.setSort('created'));
    expect(result.current.sort).toBe('created');
  });
});
