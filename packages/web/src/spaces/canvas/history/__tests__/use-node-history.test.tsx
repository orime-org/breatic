// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/canvas', () => ({
  canvasApi: {
    listNodeHistory: vi.fn(),
    fetchLimits: vi.fn(),
  },
}));

import { canvasApi, type NodeHistoryEntry } from '@web/data/api/canvas';
import { useNodeHistory } from '@web/spaces/canvas/history/use-node-history';

/**
 * QueryClientProvider wrapper for the hook under test.
 * @param client - The backing QueryClient.
 * @returns A wrapper injecting the QueryClient context.
 */
function makeWrapper(
  client: QueryClient,
): (props: { children: React.ReactNode }) => React.JSX.Element {
  return function Wrapper({
    children,
  }: {
    children: React.ReactNode;
  }): React.JSX.Element {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

/**
 * Fresh QueryClient with retries off so rejected mocks fail fast.
 * @returns A QueryClient with query retries disabled.
 */
function makeClient(): QueryClient {
  // `staleTime` matches the app's own client (`QueryClientProvider.tsx`): a
  // double that keeps pages fresh for 0ms would refetch on every mount, and
  // a test written against that proves nothing about the running app.
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
}

/**
 * Builds a success generation history entry.
 * @param id - Entry id.
 * @param content - Content URL (defaults to `<id>.png`).
 * @returns A {@link NodeHistoryEntry}.
 */
function e(id: string, content: string | null = `${id}.png`): NodeHistoryEntry {
  return {
    id,
    operatorName: null,
    entryType: 'generation',
    status: 'success',
    content,
    thumbnailUrl: null,
    errorMessage: null,
    metadata: {},
    createdAt: '2026-07-21T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(canvasApi.fetchLimits).mockResolvedValue({
    referencePoolCap: 50,
    nodeHistoryPageSize: 2,
    understandMaxBytes: 20_971_520,
  });
});

describe('useNodeHistory (#1619 paginated + deduped + loop-proof refetch)', () => {
  it('paginates by offset, stops at total, and dedups repeated ids', async () => {
    vi.mocked(canvasApi.listNodeHistory)
      .mockResolvedValueOnce({ entries: [e('a'), e('b')], total: 3 })
      // page 2 repeats 'b' (a head-insert shifted the offset window).
      .mockResolvedValueOnce({ entries: [e('b'), e('c')], total: 3 });

    const client = makeClient();
    const { result } = renderHook(() => useNodeHistory('n1', 'p1', null), {
      wrapper: makeWrapper(client),
    });

    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(result.current.total).toBe(3);
    expect(result.current.hasNextPage).toBe(true);

    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() =>
      expect(result.current.entries.map((x) => x.id)).toEqual(['a', 'b', 'c']),
    );
    expect(result.current.hasNextPage).toBe(false);
    // Second page requested at offset = loaded count (2).
    expect(vi.mocked(canvasApi.listNodeHistory)).toHaveBeenNthCalledWith(
      2,
      'n1',
      'p1',
      { limit: 2, offset: 2 },
    );
  });

  it('does not fetch while no panel is open (nodeId null)', async () => {
    const client = makeClient();
    renderHook(() => useNodeHistory(null, 'p1', null), {
      wrapper: makeWrapper(client),
    });
    await Promise.resolve();
    expect(vi.mocked(canvasApi.listNodeHistory)).not.toHaveBeenCalled();
  });

  // Opening the panel is the reader asking to see this list now. The client
  // holds pages for 30s, and a run that landed while the panel was shut moved
  // no count this hook was mounted to see — so what is cached can be a list
  // with the newest row missing.
  it('asks for the list again every time the panel opens', async () => {
    vi.mocked(canvasApi.listNodeHistory).mockResolvedValue({
      entries: [e('a', 'a.png')],
      total: 1,
    });
    const client = makeClient();
    const first = renderHook(() => useNodeHistory('n1', 'p1', 0), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(first.result.current.entries).toHaveLength(1));
    const afterFirst = vi.mocked(canvasApi.listNodeHistory).mock.calls.length;
    first.unmount();

    renderHook(() => useNodeHistory('n1', 'p1', 0), {
      wrapper: makeWrapper(client),
    });

    await waitFor(() =>
      expect(
        vi.mocked(canvasApi.listNodeHistory).mock.calls.length,
      ).toBeGreaterThan(afterFirst),
    );
  });

  it('refetches once per run that lands, never in a loop', async () => {
    vi.mocked(canvasApi.listNodeHistory).mockResolvedValue({
      entries: [e('a', 'a.png')],
      total: 1,
    });

    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    // The first reading opens the panel; it is not a run that just landed.
    let settled = 0;
    const { result, rerender } = renderHook(
      () => useNodeHistory('n1', 'p1', settled),
      { wrapper: makeWrapper(client) },
    );

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(invalidateSpy).not.toHaveBeenCalled();

    // A run reaches its end → the list asks again, once.
    settled = 1;
    rerender();
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    // Let the invalidation's refetch settle — a data-in-deps loop would keep
    // re-invalidating as new data arrives.
    await waitFor(() => expect(result.current.isPending).toBe(false));
    const afterSettle = invalidateSpy.mock.calls.length;

    // Re-render with the SAME count → the effect must NOT fire again.
    rerender();
    expect(invalidateSpy.mock.calls.length).toBe(afterSettle);
    // Edge-triggered: a single invalidation, not an ever-growing loop.
    expect(afterSettle).toBe(1);
  });
});
