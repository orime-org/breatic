// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Who is online is read from the server's list, not from what peers say.
 *
 * This set is load-bearing in a way its size hides: `useRosterRefreshOnJoin`
 * fires on an id appearing in it, and that refetch is the only moment anybody
 * learns a collaborator's name has changed. Derive it from the wrong place and
 * the failure is silent — everyone keeps rendering yesterday's name, with types
 * and the rest of the suite green.
 *
 * It used to be derived from awareness states, so the id it keyed on was one
 * each browser announced about itself. Now it comes from the list the server
 * writes from the credential each connection presented (#1886). These cases
 * pin that: seed the document, assert the set, and — the part that actually
 * catches a regression — assert that an id sitting in awareness and nowhere
 * else does not get in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useProjectMeta } from '@web/data/yjs/project-meta';

const PROJECT = 'p-1';
const ME = 'u-me';
const PEER = 'u-peer';

/** The document the hook subscribes to, shared with the mocked manager. */
let doc: Y.Doc;
/** Awareness the mocked provider exposes, so a case can plant a state in it. */
let awareness: Awareness;

vi.mock('@web/data/yjs/manager', () => ({
  docName: { projectMeta: (id: string): string => `project-${id}/meta` },
  getDoc: (): Y.Doc => doc,
}));

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    synced: boolean;
    provider: { awareness: Awareness };
    status: string;
    authFailedReason: null;
  } => ({
    synced: true,
    provider: { awareness },
    status: 'connected',
    authFailedReason: null,
  }),
}));

/**
 * Write one presence record the way the server writes it.
 * @param userId - Whose record.
 * @param online - Whether they are currently connected.
 * @param lastSeenAt - When they were last heard from.
 */
function seedPresence(
  userId: string,
  online: boolean,
  lastSeenAt = 1_000,
): void {
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    entry.set('id', userId);
    entry.set('online', online);
    entry.set('lastSeenAt', lastSeenAt);
    doc.getMap('users').set(userId, entry);
  });
}

beforeEach(() => {
  doc = new Y.Doc();
  awareness = new Awareness(doc);
});

afterEach(() => {
  awareness.destroy();
  doc.destroy();
});

describe('who is online', () => {
  it('contains the users the server marked online', async () => {
    seedPresence(ME, true);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));

    await waitFor(() => expect(result.current.onlineUserIds.has(ME)).toBe(true));
  });

  it('leaves out a user the server marked offline', async () => {
    seedPresence(ME, true);
    seedPresence(PEER, false);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));

    await waitFor(() => expect(result.current.onlineUserIds.has(ME)).toBe(true));
    expect(result.current.onlineUserIds.has(PEER)).toBe(false);
  });

  it('ignores an id that exists only in awareness', async () => {
    // The regression this file exists for. A client can put anything in its
    // awareness state; if that could still land someone in this set, the whole
    // point of having the server write the list is lost.
    awareness.setLocalStateField('user', { id: 'u-imposter' });
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));

    await waitFor(() => expect(result.current.synced).toBe(true));
    expect(result.current.onlineUserIds.has('u-imposter')).toBe(false);
  });

  it('follows the list when the server marks someone offline later', async () => {
    seedPresence(ME, true);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));
    await waitFor(() => expect(result.current.onlineUserIds.has(ME)).toBe(true));

    seedPresence(ME, false, 2_000);

    await waitFor(() =>
      expect(result.current.onlineUserIds.has(ME)).toBe(false),
    );
  });

  it('keeps no display name on the record', async () => {
    // A name here would be a copy of the account's, and copies go stale. The
    // roster is the one place a name is read from.
    seedPresence(ME, true);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));

    await waitFor(() => expect(result.current.users.get(ME)).toBeDefined());
    expect(result.current.users.get(ME)).not.toHaveProperty('name');
    expect(result.current.users.get(ME)).not.toHaveProperty('avatarUrl');
  });
});
