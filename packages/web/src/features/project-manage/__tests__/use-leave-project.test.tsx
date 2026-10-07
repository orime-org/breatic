// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api')>()),
  projectsApi: { leave: vi.fn() },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { projectsApi } from '@web/data/api';
import { toast } from '@web/lib/toast';
import { ApiException } from '@web/data/api/types';
import { studioProjectsListKey } from '@web/data/api/projects';
import { useLeaveProject } from '@web/features/project-manage/use-leave-project';

const LISTS = [
  studioProjectsListKey('acme', { archived: false, sort: 'opened', locale: 'en' }),
  studioProjectsListKey('acme', { archived: true, sort: 'archived', locale: 'en' }),
  ['studios', 'recent'],
] as const;

function setup(onLeft?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of LISTS) client.setQueryData([...key], []);
  client.setQueryData(['project', 'p1'], { id: 'p1' });
  client.setQueryData(['project', 'p1', 'credits'], { balance: 1 });
  const hook = renderHook(() => useLeaveProject('p1', 'Alley', onLeft), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return { client, ...hook };
}

/**
 * A promise the test settles by hand.
 * @returns The promise and its resolve / reject.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLeaveProject', () => {
  it('drops the project from the cache, refreshes the lists, toasts and hands over to onLeft', async () => {
    vi.mocked(projectsApi.leave).mockResolvedValue({ ok: true });
    const onLeft = vi.fn();
    const { client, result } = setup(onLeft);

    act(() => result.current.leave());

    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
    expect(projectsApi.leave).toHaveBeenCalledWith('p1');
    expect(client.getQueryState(['project', 'p1'])).toBeUndefined();
    expect(client.getQueryState(['project', 'p1', 'credits'])).toBeUndefined();
    for (const key of LISTS) {
      expect(client.getQueryState([...key])?.isInvalidated).toBe(true);
    }
    expect(toast.success).toHaveBeenCalledWith('You left “Alley”');
  });

  it('still finishes the leave after the component that started it has unmounted', async () => {
    // On the project page the collab kick swaps the page out before the
    // response lands; the follow-up must not depend on the caller staying.
    const pending = deferred<{ ok: true }>();
    vi.mocked(projectsApi.leave).mockReturnValue(pending.promise);
    const onLeft = vi.fn();
    const { result, unmount } = setup(onLeft);

    act(() => result.current.leave());
    unmount();
    pending.resolve({ ok: true });

    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith('You left “Alley”');
  });

  it('toasts the server reason when the leave is refused, and stays put', async () => {
    vi.mocked(projectsApi.leave).mockRejectedValue(
      new ApiException({
        status: 409,
        message: 'The owner has to transfer ownership before leaving.',
        fromServer: true,
      }),
    );
    const onLeft = vi.fn();
    const { client, result } = setup(onLeft);

    act(() => result.current.leave());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn\'t leave', {
        description: 'The owner has to transfer ownership before leaving.',
      }),
    );
    expect(onLeft).not.toHaveBeenCalled();
    expect(client.getQueryData(['project', 'p1'])).toEqual({ id: 'p1' });
  });

  it('reports pending while the request is in flight', async () => {
    const pending = deferred<{ ok: true }>();
    vi.mocked(projectsApi.leave).mockReturnValue(pending.promise);
    const { result } = setup();

    act(() => result.current.leave());
    await waitFor(() => expect(result.current.pending).toBe(true));
    pending.resolve({ ok: true });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});
