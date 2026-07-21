// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

  it('refetch on unmatched currentContent is edge-triggered (fires once, no loop)', async () => {
    vi.mocked(canvasApi.listNodeHistory).mockResolvedValue({
      entries: [e('a', 'a.png')],
      total: 1,
    });

    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    // currentContent matches no loaded row → the refetch effect fires.
    const { result, rerender } = renderHook(
      () => useNodeHistory('n1', 'p1', 'ghost.png'),
      { wrapper: makeWrapper(client) },
    );

    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    // Let the invalidation's refetch settle — a data-in-deps loop would keep
    // re-invalidating as new data arrives.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const afterSettle = invalidateSpy.mock.calls.length;

    // Re-render with the SAME currentContent → the effect must NOT fire again
    // (keyed only on currentContent, loaded rows read via ref).
    rerender();
    expect(invalidateSpy.mock.calls.length).toBe(afterSettle);
    // Edge-triggered: a single invalidation, not an ever-growing loop.
    expect(afterSettle).toBe(1);
  });
});
