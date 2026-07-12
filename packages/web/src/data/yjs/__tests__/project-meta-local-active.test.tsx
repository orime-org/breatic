// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: null;
    synced: boolean;
    status: 'connected';
    authFailedReason: null;
  } => ({ provider: null, synced: true, status: 'connected', authFailedReason: null }),
}));

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  appendSpace,
  openSpaceTab,
  useProjectMeta,
} from '@web/data/yjs/project-meta';

// The active Space tab is LOCAL-ONLY state (user 2026-07-11, batch-2 item 2).
// It used to live in the shared per-user Yjs subtree, which two machines on
// the SAME account both live-subscribe to — machine A clicking a tab flipped
// machine B's active tab and remounted B's running space body (interrupting
// its work). The meta projection therefore carries NO active-tab field at
// all: a remote write cannot flip what is never read.
describe('useProjectMeta — active tab is not part of the synced projection', () => {
  const projectId = 'p1';
  const userId = 'u1';

  beforeEach(() => {
    _resetForTests();
    appendSpace(projectId, { id: 's1', name: 'S1', type: 'canvas' });
    appendSpace(projectId, { id: 's2', name: 'S2', type: 'canvas' });
    openSpaceTab(projectId, userId, 's1');
  });

  it('exposes no activeSpaceId field (nothing for a remote machine to flip)', () => {
    const { result } = renderHook(() => useProjectMeta(projectId, userId));
    expect('activeSpaceId' in result.current).toBe(false);
  });

  it('a legacy activeSpaceId write from another machine changes nothing observable', () => {
    // Simulate the OTHER machine (possibly on an older build) writing the
    // legacy field into this user's shared subtree. The projection must not
    // pick it up, and openTabIds must be untouched.
    const { result } = renderHook(() => useProjectMeta(projectId, userId));
    const tabsBefore = result.current.openTabIds;
    act(() => {
      const doc = getDoc(docName.projectMeta(projectId));
      const perUser = doc.getMap<import('yjs').Map<unknown>>('perUser');
      perUser.get(userId)?.set('activeSpaceId', 's2');
    });
    expect('activeSpaceId' in result.current).toBe(false);
    expect(result.current.openTabIds).toEqual(tabsBefore);
  });
});
