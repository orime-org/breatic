// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import { useRefreshOnReauth } from '@web/pages/project/use-refresh-on-reauth';

type CloseListener = (data: { event?: { reason?: string } }) => void;

/**
 * A provider that only records `close` listeners, so the test can fire one.
 * @returns The fake and a way to fire a close.
 */
function fakeProvider() {
  const listeners = new Set<CloseListener>();
  const provider = {
    on: (event: string, cb: CloseListener) => {
      if (event === 'close') listeners.add(cb);
    },
    off: (event: string, cb: CloseListener) => {
      if (event === 'close') listeners.delete(cb);
    },
  } as unknown as HocuspocusProvider;
  const close = (reason: string): void => {
    for (const cb of listeners) cb({ event: { reason } });
  };
  return { provider, close, listeners };
}

function setup(provider: HocuspocusProvider | null) {
  const client = new QueryClient();
  client.setQueryData(['project', 'p1'], { name: 'Demo' });
  const hook = renderHook(() => useRefreshOnReauth(provider, 'p1'), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, hook };
}

describe('useRefreshOnReauth', () => {
  it('refetches the project when collab closes its meta document to re-check it', () => {
    const { provider, close } = fakeProvider();
    const { client } = setup(provider);
    close('Project archived');
    expect(client.getQueryState(['project', 'p1'])?.isInvalidated).toBe(true);
  });

  it('leaves the project alone on any other close', () => {
    const { provider, close } = fakeProvider();
    const { client } = setup(provider);
    close('Document not found');
    expect(client.getQueryState(['project', 'p1'])?.isInvalidated).toBe(false);
  });

  it('stops listening when it goes away', () => {
    const { provider, listeners } = fakeProvider();
    const { hook } = setup(provider);
    expect(listeners.size).toBe(1);
    hook.unmount();
    expect(listeners.size).toBe(0);
  });

  it('does nothing before the provider exists', () => {
    expect(() => setup(null)).not.toThrow();
  });
});
