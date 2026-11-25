// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The one read of a 3D Space's task list that the task panel, the tab spinner and the Tasks button share (inner#2061
 * design 5.5, 7.3). It counts the rows the server holds as running, a row waiting for a free running slot included;
 * it is read again when something invalidates it (the document's change version, a row action), or when a reader
 * mounts or the network reconnects after the cached list has gone stale, never on a timer; and a read that fails keeps
 * the last rows it had.
 */

import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listSpaceTasks, spaceTasksQueryKey, type SpaceTask, type SpaceTaskList } from '@web/data/api/scene';
import type * as SceneApiModule from '@web/data/api/scene';
import { useSpaceTasks } from '@web/spaces/three-d/use-space-tasks';

vi.mock('@web/data/api/scene', async (importOriginal) => {
  const actual = await importOriginal<typeof SceneApiModule>();
  return { ...actual, listSpaceTasks: vi.fn() };
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
    startedByUserId: 'user-one',
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
  vi.mocked(listSpaceTasks).mockReset().mockResolvedValue(list([]));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('useSpaceTasks', () => {
  it('counts the running rows, a row waiting for a running slot included, and no ended row', async () => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([
      row(1),
      row(2, { deadlineAt: null, waitingSince: new Date().toISOString(), slotWaitLimit: 2 }),
      row(3, { status: 'done', assetId: 'a0000000-0000-4000-8000-000000000001' }),
      row(4, { status: 'failed' }),
      row(5, { status: 'expired' }),
    ]));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTasks(PROJECT, SPACE, true), { wrapper });
    await waitFor(() => expect(result.current.running).toBe(2));
    expect(result.current.query.data?.tasks).toHaveLength(5);
  });

  it('counts 0 before the first read answers and when no row runs', async () => {
    let answer: (value: SpaceTaskList) => void = () => {};
    vi.mocked(listSpaceTasks).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTasks(PROJECT, SPACE, true), { wrapper });
    expect(result.current.running).toBe(0);
    answer(list([row(1, { status: 'done' })]));
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.running).toBe(0);
  });

  it('reads this Project and Space under the Space-task key, which a change version invalidates', async () => {
    const { client, wrapper } = provider();
    renderHook(() => useSpaceTasks(PROJECT, SPACE, true), { wrapper });
    await waitFor(() => expect(listSpaceTasks).toHaveBeenCalledTimes(1));
    expect(vi.mocked(listSpaceTasks).mock.calls[0]?.slice(0, 2)).toEqual([PROJECT, SPACE]);
    await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) });
    await waitFor(() => expect(listSpaceTasks).toHaveBeenCalledTimes(2));
  });

  it('reads nothing when not enabled', async () => {
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTasks(PROJECT, SPACE, false), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listSpaceTasks).not.toHaveBeenCalled();
    expect(result.current.running).toBe(0);
  });

  it('reads the list on no timer, even when a running row reaches its deadline', async () => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1, { deadlineAt: new Date(Date.now() + 20).toISOString() })]));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTasks(PROJECT, SPACE, true), { wrapper });
    await waitFor(() => expect(result.current.running).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(listSpaceTasks).toHaveBeenCalledTimes(1);
  });

  it('keeps counting the last rows it read when a later read fails', async () => {
    vi.mocked(listSpaceTasks).mockResolvedValue(list([row(1), row(2)]));
    const { client, wrapper } = provider();
    const { result } = renderHook(() => useSpaceTasks(PROJECT, SPACE, true), { wrapper });
    await waitFor(() => expect(result.current.running).toBe(2));
    vi.mocked(listSpaceTasks).mockRejectedValue(new Error('offline'));
    await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) });
    await waitFor(() => expect(client.getQueryState(spaceTasksQueryKey(PROJECT, SPACE))?.status).toBe('error'));
    expect(result.current.running).toBe(2);
  });
});
