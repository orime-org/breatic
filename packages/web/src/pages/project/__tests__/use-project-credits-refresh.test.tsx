// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The top bar's figure is read again whenever the Studio's credits move (inner#1611, #1580): collab says so with
 * `credits:changed`, for this user's runs and everyone else's, and nothing else reads it again.
 */

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ACTIVITY_NEW_SIGNAL, CREDITS_CHANGED_SIGNAL } from '@breatic/shared';

import { useProjectCreditsRefresh } from '@web/pages/project/use-project-credits-refresh';

const PROJECT = 'p-1';

/** A meta-doc provider double that hands its listener to the test. */
function providerDouble(): {
  provider: {
    on: (e: string, f: (d: { payload: string }) => void) => void;
    off: (e: string, f: (d: { payload: string }) => void) => void;
  };
  send: (payload: unknown) => void;
  } {
  const listeners = new Set<(d: { payload: string }) => void>();
  return {
    provider: {
      on: (_event, f) => {
        listeners.add(f);
      },
      off: (_event, f) => {
        listeners.delete(f);
      },
    },
    send: (payload) => {
      for (const listener of listeners) listener({ payload: JSON.stringify(payload) });
    },
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
  it('leaves the figure alone for activity that is not a credit change', () => {
    const { provider, send } = providerDouble();
    const view = mount(provider);
    send({ t: ACTIVITY_NEW_SIGNAL, projectId: PROJECT });
    vi.runAllTimers();
    expect(invalidate).not.toHaveBeenCalled();
    view.unmount();
  });

  it('reads the figure again when the server says a charge in the project committed', () => {
    // A chat turn is charged on the server after the user's own stream has
    // ended, and a call cut off mid-turn is charged later still.
    const { provider, send } = providerDouble();
    const view = mount(provider);
    send({ t: CREDITS_CHANGED_SIGNAL, projectId: PROJECT });
    vi.runAllTimers();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['project', PROJECT, 'credits'] });
    view.unmount();
  });

  it('ignores signals of other projects and traffic that is not a signal', () => {
    const { provider, send } = providerDouble();
    const view = mount(provider);
    send({ t: ACTIVITY_NEW_SIGNAL, projectId: 'p-2' });
    send({ t: CREDITS_CHANGED_SIGNAL, projectId: 'p-2' });
    send({ something: 'else' });
    vi.runAllTimers();
    expect(invalidate).not.toHaveBeenCalled();
    view.unmount();
  });

  it('stops listening once unmounted', () => {
    const { provider, send } = providerDouble();
    const view = mount(provider);
    view.unmount();
    send({ t: CREDITS_CHANGED_SIGNAL, projectId: PROJECT });
    vi.runAllTimers();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
