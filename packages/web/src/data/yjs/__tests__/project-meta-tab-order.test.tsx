// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: null;
    synced: boolean;
    status: 'connected';
    authFailedReason: null;
  } => ({
    provider: null,
    synced: true,
    status: 'connected',
    authFailedReason: null,
  }),
}));

import { _resetForTests } from '@web/data/yjs/manager';
import { useProjectMeta } from '@web/data/yjs/project-meta';
import {
  seedSpaceEntry,
  seedOpenTabs,
} from '@web/data/yjs/__tests__/meta-doc-fixtures';

/**
 * The two rules the tab order carries on the read side.
 *
 * A tab bar can only be right if it agrees with the one collab wrote: the
 * order a user sees before they have arranged anything has to match what
 * the server seeds the first time they touch a tab, and a list that came
 * back holding an id twice has to render as one tab.
 */
describe('useProjectMeta — the order a first-time visitor sees', () => {
  const projectId = 'p1';
  const userId = 'u1';

  beforeEach(() => {
    _resetForTests();
  });

  it('orders by createdAt, not by the order the Spaces landed in the map', () => {
    // Written newest-first, so Y.Map iteration order would give the reverse
    // of what createdAt asks for.
    seedSpaceEntry(projectId, {
      id: 's3',
      name: 'S3',
      type: 'canvas',
      createdAt: 300,
    });
    seedSpaceEntry(projectId, {
      id: 's1',
      name: 'S1',
      type: 'canvas',
      createdAt: 100,
    });
    seedSpaceEntry(projectId, {
      id: 's2',
      name: 'S2',
      type: 'canvas',
      createdAt: 200,
    });

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['s1', 's2', 's3']);
  });

  it('puts a Space with no createdAt in front of the timestamped ones', () => {
    seedSpaceEntry(projectId, {
      id: 's2',
      name: 'S2',
      type: 'canvas',
      createdAt: 100,
    });
    seedSpaceEntry(projectId, { id: 's1', name: 'S1', type: 'canvas' });

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['s1', 's2']);
  });

  it('orders the pre-auth fallback the same way', () => {
    seedSpaceEntry(projectId, {
      id: 's2',
      name: 'S2',
      type: 'canvas',
      createdAt: 200,
    });
    seedSpaceEntry(projectId, {
      id: 's1',
      name: 'S1',
      type: 'canvas',
      createdAt: 100,
    });

    const { result } = renderHook(() => useProjectMeta(projectId, undefined));

    expect(result.current.openTabIds).toEqual(['s1', 's2']);
  });

  it('leaves the Spaces list itself in map order', () => {
    // The Space drawer renders this list, and its ordering is another
    // task's. Sorting the tab defaults must not reach it.
    seedSpaceEntry(projectId, {
      id: 's3',
      name: 'S3',
      type: 'canvas',
      createdAt: 300,
    });
    seedSpaceEntry(projectId, {
      id: 's1',
      name: 'S1',
      type: 'canvas',
      createdAt: 100,
    });

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.spaces.map((s) => s.id)).toEqual(['s3', 's1']);
  });
});

describe('useProjectMeta — a stored list holding an id twice', () => {
  const projectId = 'p2';
  const userId = 'u1';

  beforeEach(() => {
    _resetForTests();
  });

  it('renders one tab per id, at the place the id first appears', () => {
    // Two collab instances that had not synced each moved the same tab, so
    // the merged list holds it twice. Both replicas agree on that list, so
    // deduping it the same way on both leaves them showing the same bar.
    seedSpaceEntry(projectId, { id: 'a', name: 'A', type: 'canvas' });
    seedSpaceEntry(projectId, { id: 'b', name: 'B', type: 'canvas' });
    seedSpaceEntry(projectId, { id: 'c', name: 'C', type: 'canvas' });
    seedOpenTabs(projectId, userId, ['b', 'a', 'c', 'a']);

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['b', 'a', 'c']);
  });

  it('leaves a list without duplicates exactly as it stands', () => {
    seedSpaceEntry(projectId, { id: 'a', name: 'A', type: 'canvas' });
    seedSpaceEntry(projectId, { id: 'b', name: 'B', type: 'canvas' });
    seedOpenTabs(projectId, userId, ['b', 'a']);

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['b', 'a']);
  });
});
