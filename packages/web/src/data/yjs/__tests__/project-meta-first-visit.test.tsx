// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
// meta doc, and the projection answers that absence with "every Space is
// open". That default is what makes a freshly created project show its
// Space instead of an empty tab bar: the creator lands on the project page
// having never opened it, so there is nothing in `perUser` yet, and the
// single Space the project was created with is the one tab that appears.
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

  it('opens every Space when the user has no record in this project', () => {
    seedSpaceEntry(projectId, { id: 's1', name: 'S1', type: 'canvas' });
    seedSpaceEntry(projectId, { id: 's2', name: 'S2', type: 'document' });

    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    expect([...result.current.openTabIds].sort()).toEqual(['s1', 's2']);
  });

  it('honors a list the user already has, rather than opening everything', () => {
    // The guard against reading the case above as "always open everything":
    // a user who HAS a list gets exactly that list, even when the project
    // holds more Spaces than the list names.
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
});
