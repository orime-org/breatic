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
 * A tab bar can only be right if it agrees with the one collab wrote: what a
 * member sees before they have arranged anything has to match what the
 * server writes on their first connection, ties included, and a list that
 * came back holding an id twice has to render as one tab.
 */
describe('useProjectMeta — what a first-time visitor gets', () => {
  const projectId = 'p1';
  const userId = 'u1';

  beforeEach(() => {
    _resetForTests();
  });

  it('picks by createdAt, not by the order the Spaces landed in the map', () => {
    // Written newest-first, so the map's iteration order would answer with
    // s3 for the wrong reason. Two replicas can disagree on that order.
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

    expect(result.current.openTabIds).toEqual(['s3']);
  });

  it('prefers a timestamped Space over one written before the field existed', () => {
    seedSpaceEntry(projectId, {
      id: 's2',
      name: 'S2',
      type: 'canvas',
      createdAt: 100,
    });
    seedSpaceEntry(projectId, { id: 's1', name: 'S1', type: 'canvas' });

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['s2']);
  });

  it('answers the pre-auth fallback the same way', () => {
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

    expect(result.current.openTabIds).toEqual(['s2']);
  });

  it('leaves the Spaces list itself in map order', () => {
    // The Space drawer renders this list, and its ordering is another
    // task's. Choosing the tab default must not reach it.
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
