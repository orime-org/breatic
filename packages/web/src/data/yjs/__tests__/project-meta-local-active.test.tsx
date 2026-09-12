// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';

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

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { useProjectMeta } from '@web/data/yjs/project-meta';
import { seedSpaceEntry } from '@web/data/yjs/__tests__/meta-doc-fixtures';

// The tab bar is runtime state of one browser tab and nothing stores it (user
// 2026-09-12). `perUser` used to hold it, and old documents still carry that
// key; the projection reads nothing from it. Two machines on one account
// therefore cannot move each other's tabs — the field a remote write lands in
// is never read.
describe('useProjectMeta — perUser is not part of the projection', () => {
  const projectId = 'p1';
  const userId = 'u1';

  beforeEach(() => {
    _resetForTests();
    seedSpaceEntry(projectId, { id: 's1', name: 'S1', type: 'canvas' });
    seedSpaceEntry(projectId, { id: 's2', name: 'S2', type: 'canvas' });
  });

  it('carries no tab-bar field at all', () => {
    const { result } = renderHook(() => useProjectMeta(projectId));
    expect('activeSpaceId' in result.current).toBe(false);
    expect('openTabIds' in result.current).toBe(false);
  });

  it('a legacy perUser record from another machine changes nothing observable', () => {
    const { result } = renderHook(() => useProjectMeta(projectId));
    const before = result.current.spaces;

    act(() => {
      // Exactly what an older build wrote: this user's own record, holding
      // both of the keys the tab bar used to live in.
      const doc = getDoc(docName.projectMeta(projectId));
      const record = new Y.Map<unknown>();
      const openTabIds = new Y.Array<string>();
      openTabIds.push(['s2']);
      doc.getMap<Y.Map<unknown>>('perUser').set(userId, record);
      record.set('openTabIds', openTabIds);
      record.set('activeSpaceId', 's2');
    });

    expect('activeSpaceId' in result.current).toBe(false);
    expect('openTabIds' in result.current).toBe(false);
    expect(result.current.spaces).toEqual(before);
  });
});
