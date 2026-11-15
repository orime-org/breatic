// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion tab spinner (#1490 design §8.3).
 *
 * For a Motion Space, `useSpaceTaskStatus` reads how many of the Space's executions are still in progress from the
 * Space list route, polling at the Project's `webAnimation.sourceRefreshIntervalMs`, and spins while that count is
 * above zero; the page's Space-task signal refetches it at once. A Timeline no longer makes web animations, so it
 * reads no execution list and spins only for its own uploads; Canvas and Document tabs never read it either.
 */

import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineClientLimits } from '@breatic/shared';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi, type SpaceExecutionPage } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { useSpaceTaskStatus } from '@web/pages/project/chrome/tab-bar/use-space-task-status';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listSpaceExecutions: vi.fn(), limits: vi.fn() } };
});

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const clients: QueryClient[] = [];

/**
 * A page of the in-progress group with these totals.
 * @param inProgress - How many executions are still in progress.
 * @returns The page.
 * @throws {never} Never.
 */
function page(inProgress: number): SpaceExecutionPage {
  return { rows: [], nextCursor: null, totals: { done: 3, inProgress } };
}

/**
 * The limits the Project answers, with a polling interval.
 * @param sourceRefreshIntervalMs - How often an unfinished list is read again.
 * @returns The limits.
 * @throws {never} Never.
 */
function limits(sourceRefreshIntervalMs: number): TimelineClientLimits {
  return { webAnimation: { sourceRefreshIntervalMs } } as unknown as TimelineClientLimits;
}

/**
 * A fresh cache and a wrapper providing it.
 * @returns Both.
 * @throws {never} Never.
 */
function provider(): { client: QueryClient; wrapper: (props: { children: React.ReactNode }) => React.JSX.Element } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return {
    client,
    wrapper: ({ children }) => <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>,
  };
}

beforeEach(() => {
  useSpaceOperationsStore.setState({ operations: {} });
  vi.mocked(timelineApi.listSpaceExecutions).mockReset().mockResolvedValue(page(0));
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(limits(3_600_000));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('useSpaceTaskStatus for a Motion Space', () => {
  it.each([[0, false], [1, true], [5, true]] as const)('with %i executions in progress spins: %s', async (inProgress, spins) => {
    vi.mocked(timelineApi.listSpaceExecutions).mockResolvedValue(page(inProgress));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'web_animation'), { wrapper });
    await waitFor(() => expect(timelineApi.listSpaceExecutions).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(spins));
  });

  it('reads this Project and Space\'s own executions', async () => {
    const { wrapper } = provider();
    renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'web_animation'), { wrapper });
    await waitFor(() => expect(timelineApi.listSpaceExecutions).toHaveBeenCalled());
    expect(vi.mocked(timelineApi.listSpaceExecutions).mock.calls.every(([params]) => (
      params.projectId === PROJECT && params.spaceId === SPACE && params.scope === 'space'
    ))).toBe(true);
  });

  it('stops once the last execution ends, by polling at the configured interval', async () => {
    vi.mocked(timelineApi.limits).mockResolvedValue(limits(20));
    vi.mocked(timelineApi.listSpaceExecutions).mockResolvedValue(page(1));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'web_animation'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    vi.mocked(timelineApi.listSpaceExecutions).mockResolvedValue(page(0));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('starts spinning at once when the Space-task signal refetches the count', async () => {
    const { client, wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'web_animation'), { wrapper });
    await waitFor(() => expect(timelineApi.listSpaceExecutions).toHaveBeenCalled());
    expect(result.current).toBe(false);
    vi.mocked(timelineApi.listSpaceExecutions).mockResolvedValue(page(1));
    await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) });
    await waitFor(() => expect(result.current).toBe(true));
  });
});

describe('useSpaceTaskStatus for the other Space types', () => {
  it.each(['timeline', 'canvas', 'document', '3d'] as const)('never reads an execution list for a %s Space', async (type) => {
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, type), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timelineApi.listSpaceExecutions).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it('spins for a background upload registered on a Timeline Space', async () => {
    const { wrapper } = provider();
    const { result, rerender } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'timeline'), { wrapper });
    useSpaceOperationsStore.getState().register(SPACE, 'b0000000-0000-4000-8000-000000000001');
    rerender();
    await waitFor(() => expect(result.current).toBe(true));
  });
});
