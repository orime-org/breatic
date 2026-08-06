// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Announcing yourself is what makes everyone else re-read the roster.
 *
 * Nothing about a name travels over the wire any more (#1882), so the only
 * moment another client learns that a name may have changed is when somebody
 * turns up. That whole mechanism starts at one line: this client writing its
 * user id into awareness. Delete it and `onlineUserIds` is permanently empty
 * on every client, no refetch ever fires, and a person who renames themselves
 * keeps their old name on everyone else's screen for the rest of the session —
 * with types, lint and the rest of the suite green.
 *
 * So this asserts the id all the way through to the online set rather than
 * spying on the publish call: a publish that lands in a field nobody derives
 * the set from would satisfy a spy and nothing else.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/** One awareness instance for the mocked socket, rebuilt per test. */
let awareness: Awareness;
/**
 * The mocked socket's return value, rebuilt per test and then STABLE — a fresh
 * object per call makes the provider a new reference on every render, which
 * re-runs the effects keyed on it and spins forever.
 */
let socket: {
  provider: { awareness: Awareness };
  synced: boolean;
  status: 'connected';
  authFailedReason: null;
};

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): typeof socket => socket,
}));

import { _resetForTests } from '@web/data/yjs/manager';
import { appendSpace, useProjectMeta } from '@web/data/yjs/project-meta';
import { useCurrentUserStore } from '@web/stores';

describe('useProjectMeta — announcing this client', () => {
  const projectId = 'p1';
  const userId = 'u-me';

  beforeEach(() => {
    _resetForTests();
    awareness = new Awareness(new Y.Doc());
    socket = {
      provider: { awareness },
      synced: true,
      status: 'connected',
      authFailedReason: null,
    };
    appendSpace(projectId, { id: 's1', name: 'S1', type: 'canvas' });
    useCurrentUserStore.setState({
      user: {
        id: userId,
        name: 'Me',
        email: 'me@e.com',
        personalStudio: { name: 'Me', slug: 'me', avatarUrl: null },
      },
      role: null,
      loading: false,
      bootstrapped: true,
    });
  });

  it('publishes this user id into awareness', async () => {
    renderHook(() => useProjectMeta(projectId, userId));

    await waitFor(() => {
      const state = awareness.getLocalState() as { user?: { id?: string } };
      expect(state?.user?.id).toBe(userId);
    });
  });

  it('publishes the id and NOTHING else about who this is', async () => {
    // The whole point of the redesign: a peer gets an id and looks the rest up.
    // A name or avatar creeping back onto the wire would reintroduce the two
    // tabs disagreeing about the same person.
    renderHook(() => useProjectMeta(projectId, userId));

    await waitFor(() => {
      const state = awareness.getLocalState() as { user?: Record<string, unknown> };
      expect(state?.user).toEqual({ id: userId });
    });
  });

  it('surfaces the announced id in the online set', async () => {
    // The consumer end: the refresh-on-join hook watches this set, so an id
    // that is published but never derived into it would trigger nothing.
    const { result } = renderHook(() => useProjectMeta(projectId, userId));

    await waitFor(() => {
      expect(result.current.onlineUserIds.has(userId)).toBe(true);
    });
  });

  it('surfaces a peer who announces themselves', async () => {
    const { result } = renderHook(() => useProjectMeta(projectId, userId));
    await waitFor(() => expect(result.current.onlineUserIds.size).toBe(1));

    awareness.getStates().set(42, { user: { id: 'u-them' } });
    awareness.emit('change', [{ added: [42], updated: [], removed: [] }, 'remote']);

    await waitFor(() => {
      expect(result.current.onlineUserIds.has('u-them')).toBe(true);
    });
  });
});
