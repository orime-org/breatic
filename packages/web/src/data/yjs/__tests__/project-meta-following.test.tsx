// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whom each member follows, read from the table the server keeps in the meta
 * document (#920, design 4.2.1).
 *
 * Expected: `useProjectMeta(projectId)` returns `following:
 * ReadonlyMap<string, string>`, user id → the user id they follow. The table is
 * the meta document's `FOLLOWING_TABLE` root (`"following"`, from
 * `@breatic/shared`), keyed by socket id, each entry a nested Y.Map
 * `{ userId, target, at, lastSeenAt }` checked with `followingEntrySchema`.
 * When one member has several entries (one per tab), the one with the latest
 * `at` wins; `lastSeenAt` only says the connection is alive and never decides
 * the pick. An entry that fails the schema counts as absent. The table is
 * watched like `users`, so in-place edits re-render too.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useProjectMeta } from '@web/data/yjs/project-meta';

const PROJECT = 'p-1';

/** The document the hook subscribes to, shared with the mocked manager. */
let doc: Y.Doc;
/** Awareness the mocked provider exposes. */
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
 * Write one entry the way the server does: a nested map under the socket id.
 * @param socketId - The connection the entry belongs to.
 * @param fields - The entry's fields.
 */
function seedEntry(socketId: string, fields: Record<string, unknown>): void {
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    doc.getMap('following').set(socketId, entry);
    for (const [key, value] of Object.entries(fields)) entry.set(key, value);
  });
}

/**
 * Change an existing entry in place, the way the server refreshes or rewrites it.
 * @param socketId - The connection the entry belongs to.
 * @param fields - The fields to set.
 * @throws {Error} When there is no entry for that socket.
 */
function updateEntry(socketId: string, fields: Record<string, unknown>): void {
  const entry = doc.getMap('following').get(socketId);
  if (!(entry instanceof Y.Map)) throw new Error(`no entry for ${socketId}`);
  doc.transact(() => {
    for (const [key, value] of Object.entries(fields)) entry.set(key, value);
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

describe('whom each member follows, from the server table', () => {
  it('takes the entry with the latest start time when a member follows from two tabs', async () => {
    seedEntry('sock-old', { userId: 'li', target: 'wang', at: 100, lastSeenAt: 1_000 });
    seedEntry('sock-new', { userId: 'li', target: 'zhao', at: 200, lastSeenAt: 1_000 });
    seedEntry('sock-w', { userId: 'wang', target: 'li', at: 50, lastSeenAt: 1_000 });

    const { result } = renderHook(() => useProjectMeta(PROJECT));

    await waitFor(() => expect(result.current.following.get('li')).toBe('zhao'));
    expect(result.current.following.get('wang')).toBe('li');
    expect(result.current.following.has('zhao')).toBe(false);
  });

  it('keeps the pick when the older tab is refreshed later', async () => {
    // Every sign of life moves `lastSeenAt`; the older tab's can pass the
    // newer tab's start time without that tab having started anything.
    seedEntry('sock-old', { userId: 'li', target: 'wang', at: 100, lastSeenAt: 1_000 });
    seedEntry('sock-new', { userId: 'li', target: 'zhao', at: 200, lastSeenAt: 1_000 });
    const { result } = renderHook(() => useProjectMeta(PROJECT));
    await waitFor(() => expect(result.current.following.get('li')).toBe('zhao'));

    updateEntry('sock-old', { lastSeenAt: 90_000 });
    updateEntry('sock-new', { lastSeenAt: 2_000 });

    await waitFor(() => expect(result.current.following.get('li')).toBe('zhao'));
  });

  it('follows an entry the server rewrites in place, and drops one it deletes', async () => {
    seedEntry('sock-a', { userId: 'li', target: 'wang', at: 100, lastSeenAt: 1_000 });
    const { result } = renderHook(() => useProjectMeta(PROJECT));
    await waitFor(() => expect(result.current.following.get('li')).toBe('wang'));

    updateEntry('sock-a', { target: 'zhao', at: 300, lastSeenAt: 3_000 });
    await waitFor(() => expect(result.current.following.get('li')).toBe('zhao'));

    doc.transact(() => doc.getMap('following').delete('sock-a'));
    await waitFor(() => expect(result.current.following.has('li')).toBe(false));
  });

  it('counts a malformed entry as absent, however late its start time', async () => {
    seedEntry('sock-good', { userId: 'li', target: 'wang', at: 100, lastSeenAt: 1_000 });
    seedEntry('sock-no-target', { userId: 'li', at: 900, lastSeenAt: 1_000 });
    seedEntry('sock-empty-target', { userId: 'li', target: '', at: 900, lastSeenAt: 1_000 });
    seedEntry('sock-text-at', { userId: 'li', target: 'zhao', at: '900', lastSeenAt: 1_000 });
    seedEntry('sock-no-user', { target: 'zhao', at: 900, lastSeenAt: 1_000 });
    doc.transact(() => doc.getMap('following').set('sock-plain', 'zhao'));

    const { result } = renderHook(() => useProjectMeta(PROJECT));

    await waitFor(() => expect(result.current.following.get('li')).toBe('wang'));
    expect(result.current.following.size).toBe(1);
  });

  it('reads nothing a peer put in its own awareness', async () => {
    // Awareness `following` is only the tab's declaration to the server.
    awareness.setLocalStateField('user', { id: 'li' });
    awareness.setLocalStateField('following', { id: 'wang', at: 100 });

    const { result } = renderHook(() => useProjectMeta(PROJECT));

    await waitFor(() => expect(result.current.synced).toBe(true));
    expect(result.current.following.size).toBe(0);
  });
});
