// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The top bar's figure is read again whenever it may have moved (inner#1611):
 * when this reader's own spend returns, and when anyone's generation in the
 * project ends. Focus refetching is off app-wide, so nothing else does it.
 */

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ACTIVITY_NEW_SIGNAL } from '@breatic/shared';

import { noteCreditsChanged } from '@web/data/api/credits';
import { useProjectCreditsRefresh } from '@web/pages/project/use-project-credits-refresh';

const PROJECT = 'p-1';

/** A meta-doc provider double that hands its listener to the test. */
function providerDouble(): {
  provider: { on: (e: string, f: (d: { payload: string }) => void) => void; off: () => void };
  send: (payload: unknown) => void;
  } {
  let listener: ((d: { payload: string }) => void) | null = null;
  return {
    provider: {
      on: (_event, f) => {
        listener = f;
      },
      off: () => {
        listener = null;
      },
    },
    send: (payload) => listener?.({ payload: JSON.stringify(payload) }),
  };
}

let client = new QueryClient();
let invalidate = vi.spyOn(client, 'invalidateQueries');

/**
 * The hook under a query client.
 * @param provider - The meta-doc provider, or null.
 * @returns The render result.
 */
function mount(provider: ReturnType<typeof providerDouble>['provider'] | null) {
  return renderHook(() => useProjectCreditsRefresh(PROJECT, provider as never), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  invalidate = vi.spyOn(client, 'invalidateQueries');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useProjectCreditsRefresh', () => {
  it('reads the figure again when this reader\'s own spend in this project returns', () => {
    const view = mount(null);
    noteCreditsChanged(PROJECT);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', PROJECT, 'credits'] });
    view.unmount();
  });

  it('leaves the figure alone for another project\'s spend', () => {
    const view = mount(null);
    noteCreditsChanged('p-2');
    expect(invalidate).not.toHaveBeenCalled();
    view.unmount();
  });

  it('reads the figure again when a generation in the project ends, for anyone', () => {
    const { provider, send } = providerDouble();
    const view = mount(provider);
    send({ t: ACTIVITY_NEW_SIGNAL, projectId: PROJECT });
    vi.runAllTimers();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', PROJECT, 'credits'] });
    view.unmount();
  });

  it('ignores signals of other projects and traffic that is not a signal', () => {
    const { provider, send } = providerDouble();
    const view = mount(provider);
    send({ t: ACTIVITY_NEW_SIGNAL, projectId: 'p-2' });
    send({ something: 'else' });
    vi.runAllTimers();
    expect(invalidate).not.toHaveBeenCalled();
    view.unmount();
  });

  it('stops listening once unmounted', () => {
    const view = mount(null);
    view.unmount();
    noteCreditsChanged(PROJECT);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
