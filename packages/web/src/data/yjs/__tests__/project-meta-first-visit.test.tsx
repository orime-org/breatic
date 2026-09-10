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

// A user who has never opened this project has no `perUser` subtree in the
// meta doc, and the projection answers that absence with the newest Space,
// alone — the same list collab writes on their first connection. That
// default is what makes a freshly created project show its Space instead of
// an empty tab bar: the creator lands on the project page having never
// opened it, so there is nothing in `perUser` yet, and the single Space the
// project was created with is the one tab that appears.
// `resolveEffectiveActiveSpace` then activates it, since the window has no
// local choice yet — the two halves together are the whole of "create a
// project and its Space is open and active".
//
// The other half is pinned in `pages/project/__tests__/active-space.test.ts`.
// This half had nothing: mutating the default to `[]` left every test in the
// web package green, which is why these cases exist.
describe('useProjectMeta — what a first-time visitor sees in the tab bar', () => {
  const projectId = 'p1';
  const userId = 'u1';

  beforeEach(() => {
    _resetForTests();
  });

  it('opens the newest Space alone when the user has no record here', () => {
    // One tab means one content document on the socket. Neither of these
    // carries a `createdAt`, so the tie falls to the id, the same way it does
    // on the server.
    seedSpaceEntry(projectId, { id: 's1', name: 'S1', type: 'canvas' });
    seedSpaceEntry(projectId, { id: 's2', name: 'S2', type: 'document' });

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['s2']);
  });

  it('honors a list the user already has, rather than opening everything', () => {
    // The guard against reading the case above as a rule about every read:
    // a user who HAS a list gets exactly that list, whatever the default
    // would have said.
    seedSpaceEntry(projectId, { id: 's1', name: 'S1', type: 'canvas' });
    seedSpaceEntry(projectId, { id: 's2', name: 'S2', type: 'document' });
    seedOpenTabs(projectId, userId, ['s1']);

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['s1']);
  });

  it('shows the one Space a newly created project was born with', () => {
    // The shape a project has the moment it is created from the Studio: one
    // Space, and a creator who has never opened the project. This is the
    // case the product promise rests on, so it is stated on its own rather
    // than left as a corollary of the first one.
    seedSpaceEntry(projectId, { id: 'doc-1', name: 'Document', type: 'document' });

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['doc-1']);
  });

  it('falls back when every id in a stored list names a Space that is gone', () => {
    // A seeded list holds one Space. Somebody else deleting it takes the
    // list's only entry with it — and when the delete ran on an instance
    // that had not yet received this member's list, the removal never
    // happened there, so what merges is a list holding a dead id. Either way
    // the bar would resolve to nothing and stay that way: a stored list is a
    // real list, so the first-visit default never fires for it again.
    seedSpaceEntry(projectId, { id: 's-live', name: 'Live', type: 'canvas' });
    seedOpenTabs(projectId, userId, ['s-deleted']);

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['s-live']);
  });

  it('keeps a list that still names one live Space, dead ids and all', () => {
    // The repair is for a bar with nothing left in it. A list that still
    // resolves to something is the member's own arrangement, and dropping
    // the dead ids out of what is shown is `ProjectPage`'s job.
    seedSpaceEntry(projectId, { id: 's-live', name: 'Live', type: 'canvas' });
    seedOpenTabs(projectId, userId, ['s-deleted', 's-live']);

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual(['s-deleted', 's-live']);
  });

  it('leaves an empty list empty, because closing every tab is a choice', () => {
    // Somebody who closed their last tab meant to. The repair reads "this
    // list points only at Spaces that no longer exist", which an empty list
    // does not.
    seedSpaceEntry(projectId, { id: 's-live', name: 'Live', type: 'canvas' });
    seedOpenTabs(projectId, userId, []);

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect(result.current.openTabIds).toEqual([]);
  });
});
