// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The 3D tab spinner (inner#2061 design 5.5, 7.3).
 *
 * For a 3D Space, `useSpaceTaskStatus` reads the Space's task list through `useSpaceTasks(projectId, spaceId,
 * type === '3d')` and spins while the server holds a running row: another member's upload, a background generation, a
 * row waiting for a running slot. It needs no open task panel; a new change version in the Space's document reads the
 * list again, and nothing reads it on a timer. A read that fails leaves the spinner on the rows it last read. Canvas,
 * Document and Timeline tabs never read the 3D list.
 */

import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listSpaceTasks, spaceTasksQueryKey, type SpaceTask, type SpaceTaskList } from '@web/data/api/scene';
import type * as SceneApiModule from '@web/data/api/scene';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { useSpaceTaskStatus } from '@web/pages/project/chrome/tab-bar/use-space-task-status';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

vi.mock('@web/data/api/scene', async (importOriginal) => {
  const actual = await importOriginal<typeof SceneApiModule>();
  return { ...actual, listSpaceTasks: vi.fn() };
});

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listExecutions: vi.fn(), limits: vi.fn() } };
});

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const clients: QueryClient[] = [];

/**
 * A row of the list.
 * @param n - Its ordinal, for a distinct id.
 * @param over - What differs from a row running inside its budget.
 * @returns The row.
 * @throws {never} Never.
 */
function row(n: number, over: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    label: `lamp-${n}.glb`,
    status: 'running',
    startedByUserId: 'someone-else',
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    assetId: null,
    ...over,
  };
}

/**
 * The list as the server answers it.
 * @param tasks - Its rows.
 * @returns The answer.
 * @throws {never} Never.
 */
function list(tasks: SpaceTask[]): SpaceTaskList {
  return { serverNow: new Date().toISOString(), tasks };
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
  vi.mocked(listSpaceTasks).mockReset().mockResolvedValue(list([]));
  vi.mocked(timelineApi.listExecutions).mockReset().mockResolvedValue([]);
  vi.mocked(timelineApi.limits).mockReset();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('useSpaceTaskStatus for a 3D Space', () => {
  it.each([
    ['a running upload', row(1)],
    ['a row waiting for a running slot', row(1, { deadlineAt: null, waitingSince: new Date().toISOString(), slotWaitLimit: 2 })],
  ])('spins for %s the server holds, with no task panel open', async (_name, running) => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(2, { status: 'done' }), running]));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it.each(['done', 'failed', 'expired'] as const)('does not spin when every row is %s', async (status) => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1, { status })]));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'), { wrapper });
    await waitFor(() => expect(listSpaceTasks).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBe(false);
  });

  it('starts spinning when a change version reads the list again', async () => {
    const { client, wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'), { wrapper });
    await waitFor(() => expect(listSpaceTasks).toHaveBeenCalled());
    expect(result.current).toBe(false);
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1)]));
    await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stops spinning once a change version reads the list with the last row ended, the sweep expiring it included', async () => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1)]));
    const { client, wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1, { status: 'expired' })]));
    await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('keeps spinning on the rows it last read when a later read fails', async () => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1)]));
    const { client, wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    vi.mocked(listSpaceTasks).mockRejectedValue(new Error('offline'));
    await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBe(true);
  });

  it('reads the list on no timer while a row runs', async () => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1, { deadlineAt: new Date(Date.now() + 20).toISOString() })]));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(listSpaceTasks).toHaveBeenCalledTimes(1);
  });

  it('spins for this page\'s own upload before the server lists it', async () => {
    const { wrapper } = provider();
    const { result, rerender } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, '3d'), { wrapper });
    await waitFor(() => expect(listSpaceTasks).toHaveBeenCalled());
    useSpaceOperationsStore.getState().register(SPACE, 'b0000000-0000-4000-8000-000000000001');
    rerender();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it.each(['canvas', 'document', 'timeline'] as const)('never reads the 3D task list for a %s Space', async (type) => {
    const { wrapper } = provider();
    renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, type), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listSpaceTasks).not.toHaveBeenCalled();
  });
});
