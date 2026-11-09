// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Timeline tab spinner (#1434 design §4.5).
 *
 * For a Timeline Space, `useSpaceTaskStatus` reads the Space's execution list through
 * `useTimelineExecutions(projectId, spaceId, refreshMs, { enabled: type === 'timeline' })`, polling at the Project's
 * `webAnimation.sourceRefreshIntervalMs`, and spins while any row has `!timelineExecutionEnded(status)`: the same
 * test the execution list's In Progress view uses. It needs no mounted Timeline editor, and the page's Space-task
 * signal refetches it at once. Canvas and Document tabs never read the list.
 */

import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineClientLimits, TimelineExecutionRow } from '@breatic/shared';
import { TimelineExecutionStatusSchema, timelineExecutionEnded } from '@breatic/shared/space-content';

import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { useSpaceTaskStatus } from '@web/pages/project/chrome/tab-bar/use-space-task-status';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listExecutions: vi.fn(), limits: vi.fn() } };
});

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const clients: QueryClient[] = [];

/**
 * An execution row in a status.
 * @param n - Its ordinal, for a distinct id.
 * @param status - Its status.
 * @returns The row.
 * @throws {never} Never.
 */
function row(n: number, status: TimelineExecutionRow['status']): TimelineExecutionRow {
  return {
    id: `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: PROJECT,
    spaceId: SPACE,
    actorUserId: 'user-one',
    kind: 'web_animation_create',
    actionId: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    input: {},
    inputHash: 'sha256:abc',
    engine: 'deepseek',
    status,
    phase: null,
    steps: [],
    attempt: 1,
    fence: null,
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    resultSourceVersionId: null,
    failureReason: null,
    billedCredits: null,
    billedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    usageCredits: 0,
  };
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
 * A fresh cache and a wrapper providing it, optionally with an unvisited hidden content Activity beside the hook.
 * @param hiddenContent - Whether to render a hidden Activity, as the Project page does for a tab never entered.
 * @returns Both.
 * @throws {never} Never.
 */
function provider(hiddenContent = false): { client: QueryClient; wrapper: (props: { children: React.ReactNode }) => React.JSX.Element } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return {
    client,
    wrapper: ({ children }) => <QueryClientProvider client={client}>
      {children}
      {hiddenContent && <React.Activity mode='hidden'><span>Timeline editor</span></React.Activity>}
    </QueryClientProvider>,
  };
}

beforeEach(() => {
  useSpaceOperationsStore.setState({ operations: {} });
  vi.mocked(timelineApi.listExecutions).mockReset().mockResolvedValue([]);
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(limits(3_600_000));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('useSpaceTaskStatus for a Timeline Space', () => {
  it.each(TimelineExecutionStatusSchema.options)('spins exactly when an execution in %s has not ended', async (status) => {
    vi.mocked(timelineApi.listExecutions).mockResolvedValue([row(1, 'succeeded'), row(2, status)]);
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'timeline'), { wrapper });
    await waitFor(() => expect(timelineApi.listExecutions).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBe(!timelineExecutionEnded(status)));
  });

  it('reads this Project and Space only', async () => {
    const { wrapper } = provider();
    renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'timeline'), { wrapper });
    await waitFor(() => expect(timelineApi.listExecutions).toHaveBeenCalled());
    expect(vi.mocked(timelineApi.listExecutions).mock.calls.every(([projectId, spaceId]) => projectId === PROJECT && spaceId === SPACE)).toBe(true);
  });

  it('stops once the last execution ends, by polling at the configured interval', async () => {
    vi.mocked(timelineApi.limits).mockResolvedValue(limits(20));
    vi.mocked(timelineApi.listExecutions).mockResolvedValue([row(1, 'running'), row(2, 'succeeded')]);
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'timeline'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    vi.mocked(timelineApi.listExecutions).mockResolvedValue([row(1, 'failed'), row(2, 'succeeded')]);
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('starts spinning at once when the Space-task signal refetches the list', async () => {
    const { client, wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'timeline'), { wrapper });
    await waitFor(() => expect(timelineApi.listExecutions).toHaveBeenCalled());
    expect(result.current).toBe(false);
    vi.mocked(timelineApi.listExecutions).mockResolvedValue([row(1, 'queued')]);
    await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('spins for an execution while the Timeline editor was never entered', async () => {
    vi.mocked(timelineApi.listExecutions).mockResolvedValue([row(1, 'awaiting_landing')]);
    const { wrapper } = provider(true);
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'timeline'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('spins for a background upload registered on the Timeline Space with no execution', async () => {
    const { wrapper } = provider();
    const { result, rerender } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'timeline'), { wrapper });
    await waitFor(() => expect(timelineApi.listExecutions).toHaveBeenCalled());
    useSpaceOperationsStore.getState().register(SPACE, 'b0000000-0000-4000-8000-000000000001');
    rerender();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it.each(['canvas', 'document'] as const)('never reads the execution list for a %s Space', async (type) => {
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, type), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timelineApi.listExecutions).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });
});
