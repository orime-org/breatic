// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ASSIGNMENTS_CHANGED_SIGNAL } from '@breatic/shared';
import { commentAssignmentsKey } from '@web/data/api/agent-access';
import { useCommentAssignmentsRefresh } from '@web/pages/project/use-comment-assignments-refresh';

const PROJECT = 'p-1';

type Listener = (d: { payload: string }) => void;

/**
 * A meta-doc provider double that hands its listeners to the test.
 * @returns The provider, a stateless sender and a synced sender.
 */
function providerDouble(): {
  provider: { on: (e: string, f: Listener) => void; off: (e: string, f: Listener) => void };
  send: (payload: unknown) => void;
  synced: () => void;
  } {
  const listeners = new Map<string, Set<Listener>>();
  const of = (event: string): Set<Listener> => listeners.get(event) ?? listeners.set(event, new Set()).get(event)!;
  return {
    provider: { on: (event, f) => { of(event).add(f); }, off: (event, f) => { of(event).delete(f); } },
    send: (payload) => { for (const f of of('stateless')) f({ payload: JSON.stringify(payload) }); },
    synced: () => { for (const f of of('synced')) f({ payload: '' }); },
  };
}

/**
 * Mount the hook on a fresh client.
 * @param provider - The provider double.
 * @returns The spy on the client's invalidation and the unmount.
 */
function mount(provider: unknown): { invalidate: { mock: { calls: unknown[][] } }; unmount: () => void } {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const { unmount } = renderHook(() => useCommentAssignmentsRefresh(PROJECT, provider as never), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { invalidate, unmount };
}

describe('reading the hand-over labels again (#1488 §11.7)', () => {
  it('reads the signalled Space again, and nothing for another project or signal', () => {
    const { provider, send } = providerDouble();
    const { invalidate } = mount(provider);
    send({ t: ASSIGNMENTS_CHANGED_SIGNAL, projectId: PROJECT, spaceId: 's-1' });
    send({ t: ASSIGNMENTS_CHANGED_SIGNAL, projectId: 'other', spaceId: 's-2' });
    send({ t: 'credits:changed', projectId: PROJECT });
    expect(invalidate.mock.calls).toEqual([[{ queryKey: commentAssignmentsKey(PROJECT, 's-1') }]]);
  });

  it('reads every Space of the project again once the connection is synced again', () => {
    const { provider, synced } = providerDouble();
    const { invalidate } = mount(provider);
    synced();
    expect(invalidate.mock.calls).toEqual([[{ queryKey: commentAssignmentsKey(PROJECT) }]]);
  });

  it('stops listening when unmounted', () => {
    const { provider, send, synced } = providerDouble();
    const { invalidate, unmount } = mount(provider);
    unmount();
    send({ t: ASSIGNMENTS_CHANGED_SIGNAL, projectId: PROJECT, spaceId: 's-1' });
    synced();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
