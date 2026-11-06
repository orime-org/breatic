// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPACE_TASKS_CHANGED_SIGNAL } from '@breatic/shared';
import { spaceTasksQueryKey } from '@web/data/api/scene';
import { useSpaceTasksRefresh } from '@web/pages/project/use-space-tasks-refresh';

const PROJECT = 'p-1';

/**
 * A meta-doc provider double that hands its listener to the test.
 * @returns The provider and a sender.
 */
function providerDouble(): { provider: { on: (e: string, f: (d: { payload: string }) => void) => void; off: (e: string, f: (d: { payload: string }) => void) => void }; send: (payload: unknown) => void } {
  const listeners = new Set<(d: { payload: string }) => void>();
  return {
    provider: { on: (_event, f) => { listeners.add(f); }, off: (_event, f) => { listeners.delete(f); } },
    send: (payload) => { for (const listener of listeners) listener({ payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }); },
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('reading a 3D Space\'s task list again when the server says it changed (inner#1690)', () => {
  it('invalidates exactly the signalled Space\'s list', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { provider, send } = providerDouble();
    renderHook(() => useSpaceTasksRefresh(PROJECT, provider as never), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    send({ t: SPACE_TASKS_CHANGED_SIGNAL, projectId: PROJECT, spaceId: 's-1' });
    send({ t: SPACE_TASKS_CHANGED_SIGNAL, projectId: 'other', spaceId: 's-2' });
    send({ t: 'credits:changed', projectId: PROJECT });
    send('not json');

    expect(invalidate.mock.calls).toEqual([[{ queryKey: spaceTasksQueryKey(PROJECT, 's-1') }]]);
  });

  it('stops listening when unmounted', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { provider, send } = providerDouble();
    const { unmount } = renderHook(() => useSpaceTasksRefresh(PROJECT, provider as never), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    unmount();
    send({ t: SPACE_TASKS_CHANGED_SIGNAL, projectId: PROJECT, spaceId: 's-1' });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
