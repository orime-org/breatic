// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioStore } from '@web/stores/studio';

describe('useStudioStore', () => {
  beforeEach(() => {
    useStudioStore.setState({
      search: '',
      sortKey: 'updated',
      sortOrder: 'desc',
      filterOwnerOnly: false,
    });
  });

  it('initial sort is updated desc, no search, no owner filter', () => {
    const s = useStudioStore.getState();
    expect(s.search).toBe('');
    expect(s.sortKey).toBe('updated');
    expect(s.sortOrder).toBe('desc');
    expect(s.filterOwnerOnly).toBe(false);
  });

  it('setSort updates both key and order', () => {
    useStudioStore.getState().setSort('name', 'asc');
    const s = useStudioStore.getState();
    expect(s.sortKey).toBe('name');
    expect(s.sortOrder).toBe('asc');
  });

  it('setSearch updates query', () => {
    useStudioStore.getState().setSearch('cyber');
    expect(useStudioStore.getState().search).toBe('cyber');
  });
});
