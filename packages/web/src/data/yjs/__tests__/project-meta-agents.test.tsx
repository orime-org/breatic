// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External agents' presence in the meta document (#1488 design 19.2): their
 * records sit in `users` under `{userId}.agent.{connectionId}` and are read
 * out as `agents`, never as members, so an agent never marks its owner online.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { useProjectMeta } from '@web/data/yjs/project-meta';

let doc: Y.Doc;

vi.mock('@web/data/yjs/manager', () => ({
  docName: { projectMeta: (id: string): string => `project-${id}/meta` },
  getDoc: (): Y.Doc => doc,
}));

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): { synced: boolean; provider: null; status: string; authFailedReason: null } => ({
    synced: true,
    provider: null,
    status: 'connected',
    authFailedReason: null,
  }),
}));

/**
 * Write one `users` record the way collab does.
 * @param key - Its key.
 * @param fields - Its fields; `agent` becomes a nested map.
 */
function seed(key: string, fields: Record<string, unknown>): void {
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    doc.getMap('users').set(key, entry);
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'agent') {
        const agent = new Y.Map<unknown>();
        entry.set('agent', agent);
        for (const [ak, av] of Object.entries(v as Record<string, unknown>)) agent.set(ak, av);
      } else entry.set(k, v);
    }
  });
}

const AGENT = { connectionId: 'c1', spaceId: 's1', focus: ['n1', 'n2'], focusAt: 5 };

beforeEach(() => {
  doc = new Y.Doc();
});

describe('agents in the meta document', () => {
  it('reads an agent record as an agent, and never as its owner', () => {
    seed('u1', { id: 'u1', online: false, lastSeenAt: 1 });
    seed('u1.agent.c1', { id: 'u1', online: true, lastSeenAt: 9, agent: AGENT });
    const { result } = renderHook(() => useProjectMeta('p'));
    expect([...result.current.users.keys()]).toEqual(['u1']);
    expect(result.current.users.get('u1')?.online).toBe(false);
    expect(result.current.agents).toEqual([
      { ownerId: 'u1', connectionId: 'c1', online: true, idle: false, lastSeenAt: 9, spaceId: 's1', focus: ['n1', 'n2'], focusAt: 5 },
    ]);
  });

  it('reads idle, and follows changes made in place', () => {
    seed('u1.agent.c1', { id: 'u1', online: true, lastSeenAt: 9, agent: AGENT });
    const { result } = renderHook(() => useProjectMeta('p'));
    act(() => {
      (doc.getMap('users').get('u1.agent.c1') as Y.Map<unknown>).set('idle', true);
    });
    expect(result.current.agents[0]?.idle).toBe(true);
  });

  it('leaves out a record that does not have the agent shape', () => {
    seed('u1.agent.c1', { id: 'u1', online: true, lastSeenAt: 9 });
    const { result } = renderHook(() => useProjectMeta('p'));
    expect(result.current.agents).toEqual([]);
    expect(result.current.users.size).toBe(0);
  });
});
