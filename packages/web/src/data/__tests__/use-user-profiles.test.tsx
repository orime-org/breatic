// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { usersApi } from '@web/data/api/users';
import { useUserProfiles } from '@web/data/use-user-profiles';

vi.mock('@web/data/api/users', () => ({
  usersApi: { getByIds: vi.fn() },
}));

/**
 * A query provider that never retries, so a rejection surfaces at once.
 * @param root0 - The component props.
 * @param root0.children - What to render inside the provider.
 * @returns The wrapped tree.
 */
function Wrapper({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

/**
 * Run the hook over a list of ids.
 * @param ids - The user ids to resolve.
 * @returns The render result.
 */
function run(
  ids: readonly string[],
): ReturnType<typeof renderHook<ReturnType<typeof useUserProfiles>, unknown>> {
  return renderHook(() => useUserProfiles(ids), { wrapper: Wrapper });
}

describe('resolving the people named on a sticky', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the account endpoint, not the project roster', async () => {
    // The roster holds who is on the project NOW. A11 says a note keeps its
    // author's name after they leave, and only the account endpoint can
    // answer that — it is not scoped to a project.
    vi.mocked(usersApi.getByIds).mockResolvedValue([
      { id: 'u1', name: 'Ines', email: 'ines@example.com' },
    ]);
    const { result } = run(['u1']);
    await waitFor(() => expect(result.current.get('u1')?.name).toBe('Ines'));
    expect(vi.mocked(usersApi.getByIds)).toHaveBeenCalledWith(['u1']);
  });

  it('keys the result by id so a caller need not search a list', async () => {
    vi.mocked(usersApi.getByIds).mockResolvedValue([
      { id: 'u1', name: 'Ines', email: '' },
      { id: 'u2', name: 'Rafa', email: '' },
    ]);
    const { result } = run(['u1', 'u2']);
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('u2')?.name).toBe('Rafa');
  });

  it('asks once for a repeated id', async () => {
    // A sticky whose author wrote three of the replies names them four times.
    vi.mocked(usersApi.getByIds).mockResolvedValue([
      { id: 'u1', name: 'Ines', email: '' },
    ]);
    const { result } = run(['u1', 'u1', 'u1']);
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(vi.mocked(usersApi.getByIds)).toHaveBeenCalledWith(['u1']);
  });

  it('asks in a stable order, so two stickies share one answer', async () => {
    // The ids go into the query key. Left in the order each sticky happens to
    // name them, the same two people are two different queries and the second
    // sticky waits on a request that is already in flight for the first.
    vi.mocked(usersApi.getByIds).mockResolvedValue([]);
    run(['u2', 'u1']);
    await waitFor(() =>
      expect(vi.mocked(usersApi.getByIds)).toHaveBeenCalledWith(['u1', 'u2']),
    );
  });

  it('asks nothing when there is nobody to name', () => {
    const { result } = run([]);
    expect(result.current.size).toBe(0);
    expect(vi.mocked(usersApi.getByIds)).not.toHaveBeenCalled();
  });

  it('hands back an empty map while the answer is in flight', () => {
    vi.mocked(usersApi.getByIds).mockReturnValue(new Promise(() => {}));
    const { result } = run(['u1']);
    expect(result.current.size).toBe(0);
  });

  it('hands back an empty map when the request fails', async () => {
    // A note whose author cannot be resolved still has to render: the body is
    // the point, and the header falls back to saying we do not know who.
    vi.mocked(usersApi.getByIds).mockRejectedValue(new Error('offline'));
    const { result } = run(['u1']);
    await waitFor(() => expect(result.current.size).toBe(0));
  });

  it('keeps the same map across renders that change nothing', async () => {
    // The map goes into callbacks and dependency lists on the canvas, where a
    // fresh object every render is what stops `React.memo` bailing out.
    vi.mocked(usersApi.getByIds).mockResolvedValue([
      { id: 'u1', name: 'Ines', email: '' },
    ]);
    const { result, rerender } = run(['u1']);
    await waitFor(() => expect(result.current.size).toBe(1));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
