// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { NOTIFICATIONS_CHANGED_SIGNAL } from '@breatic/shared';
import { useNotificationsRefresh } from '@web/pages/project/use-notifications-refresh';

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
  const { unmount } = renderHook(() => useNotificationsRefresh(provider as never), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { invalidate, unmount };
}

describe('reading the bell again on the project page (#1488 §11.9)', () => {
  it('reads the notifications again when collab says they changed, and for no other signal', () => {
    const { provider, send } = providerDouble();
    const { invalidate } = mount(provider);
    send({ t: NOTIFICATIONS_CHANGED_SIGNAL });
    send({ t: 'credits:changed', projectId: 'p1' });
    expect(invalidate.mock.calls).toEqual([[{ queryKey: ['notifications'] }]]);
  });

  it('reads them again once the connection is synced again, which covers what changed while it was down', () => {
    const { provider, synced } = providerDouble();
    const { invalidate } = mount(provider);
    synced();
    expect(invalidate.mock.calls).toEqual([[{ queryKey: ['notifications'] }]]);
  });

  it('stops listening once unmounted', () => {
    const { provider, send } = providerDouble();
    const { invalidate, unmount } = mount(provider);
    unmount();
    send({ t: NOTIFICATIONS_CHANGED_SIGNAL });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
