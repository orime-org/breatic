// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who is online is read from the server's list, not from what peers say.
 *
 * This flag is load-bearing in a way its size hides: `useRosterRefreshOnJoin`
 * fires when it turns true, and that refetch is the only moment anybody learns
 * a collaborator's name has changed. Read it from the wrong place and the
 * failure is silent — everyone keeps rendering yesterday's name, with types and
 * the rest of the suite green.
 *
 * Presence used to be derived from awareness states, so the id it keyed on was
 * one each browser announced about itself. Now it is the list the server writes
 * from the credential each connection presented (#1886). These cases pin that:
 * seed the document, assert the flag, and — the part that actually catches a
 * regression — assert that an id sitting in awareness and nowhere else never
 * appears at all.
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
 * Write one presence record the way the server writes it FOR THE FIRST TIME:
 * a new nested map, set on the root.
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

/**
 * Change an EXISTING record in place, which is what every write after the first
 * one does — the sweep flipping somebody off, a heartbeat pushing a timestamp.
 *
 * The distinction is the whole reason this helper exists separately. Replacing
 * the nested map is a change to the ROOT, which a plain `observe` sees; editing
 * the existing one is a change one level down, which only `observeDeep` sees.
 * Written with the wrong one, a case that says it watches somebody go offline
 * passes while the subscription that has to notice it is broken — measured: with
 * `users.observeDeep` swapped for `users.observe`, every case in this file
 * stayed green while a real collaborator would have been rendered as online
 * forever after disconnecting.
 * @param userId - Whose record.
 * @param online - The new online flag.
 * @param lastSeenAt - The new timestamp.
 */
function updatePresence(
  userId: string,
  online: boolean,
  lastSeenAt: number,
): void {
  const entry = doc.getMap('users').get(userId);
  if (!(entry instanceof Y.Map)) throw new Error(`no record for ${userId}`);
  doc.transact(() => {
    entry.set('online', online);
    entry.set('lastSeenAt', lastSeenAt);
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
  it('reports the users the server marked online', async () => {
    seedPresence(ME, true);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));

    await waitFor(() => expect(result.current.users.get(ME)?.online).toBe(true));
  });

  it('reports a user the server marked offline as offline', async () => {
    // Their record stays — the server flips the flag, it never deletes a row —
    // so "gone" has to be readable off the flag, not off the id's absence.
    seedPresence(ME, true);
    seedPresence(PEER, false);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));

    await waitFor(() => expect(result.current.users.get(ME)?.online).toBe(true));
    expect(result.current.users.get(PEER)?.online).toBe(false);
  });

  it('ignores an id that exists only in awareness', async () => {
    // The regression this file exists for. A client can put anything in its
    // awareness state; if that could still land someone in this set, the whole
    // point of having the server write the list is lost.
    awareness.setLocalStateField('user', { id: 'u-imposter' });
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));

    await waitFor(() => expect(result.current.synced).toBe(true));
    expect(result.current.users.has('u-imposter')).toBe(false);
  });

  it('follows the list when the server marks someone offline later', async () => {
    // In place, the way the sweep does it — see `updatePresence` for why the
    // difference between this and a fresh nested map decides whether this case
    // can see a regression at all.
    seedPresence(ME, true);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));
    await waitFor(() => expect(result.current.users.get(ME)?.online).toBe(true));

    updatePresence(ME, false, 2_000);

    await waitFor(() =>
      expect(result.current.users.get(ME)?.online).toBe(false),
    );
  });

  it('follows it back when a heartbeat puts them online again', async () => {
    // The other direction, and it travels the same way: the server writes both
    // by editing the existing record, never by replacing it.
    seedPresence(ME, false);
    const { result } = renderHook(() => useProjectMeta(PROJECT, ME));
    await waitFor(() => expect(result.current.synced).toBe(true));
    expect(result.current.users.get(ME)?.online).toBe(false);

    updatePresence(ME, true, 3_000);

    await waitFor(() => expect(result.current.users.get(ME)?.online).toBe(true));
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
