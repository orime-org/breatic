// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Motion tab spinner (#1490 design §8.3).
 *
 * For a Motion Space, `useSpaceTaskStatus` reads how many of the Space's executions are still in progress from the
 * Space list route and spins while that count is above zero; it reads the count again when the Space's document
 * records an execution change (#1490 design §4.7) and never polls. A Timeline no longer makes web animations, so it
 * reads no execution list and spins only for its own uploads; Canvas and Document tabs never read it either.
 */

import * as React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_TASKS_KEY, SPACE_TASKS_VERSION, webAnimationSpaceDocName } from '@breatic/shared';

import { getDoc } from '@web/data/yjs/manager';
import { timelineApi, type SpaceExecutionPage } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { useSpaceTaskStatus } from '@web/pages/project/chrome/tab-bar/use-space-task-status';
import { SpaceTasksWatcher } from '@web/pages/project/SpaceTasksWatcher';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listSpaceExecutions: vi.fn() } };
});

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const clients: QueryClient[] = [];

/**
 * A page of the in-progress group with these totals, holding that many rows as the server answers it.
 * @param inProgress - How many executions are still in progress.
 * @returns The page.
 * @throws {never} Never.
 */
function page(inProgress: number): SpaceExecutionPage {
  const rows = Array.from({ length: inProgress }, (_, index) => ({ id: `90000000-0000-4000-8000-00000000000${index}`, status: 'running' }));
  return { rows: rows as unknown as SpaceExecutionPage['rows'], nextCursor: null, totals: { running: inProgress, succeeded: 3, failed: 0 } };
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
      <SpaceTasksWatcher projectId={PROJECT} spaceId={SPACE} name={webAnimationSpaceDocName(PROJECT, SPACE)} />
      {children}
    </QueryClientProvider>,
  };
}

/**
 * Write an executions version into the Motion Space's document, the way collab does.
 * @param version - The stream id.
 */
function recordChange(version: string): void {
  getDoc(webAnimationSpaceDocName(PROJECT, SPACE)).getMap(SPACE_TASKS_KEY).set(SPACE_TASKS_VERSION, version);
}

beforeEach(() => {
  useSpaceOperationsStore.setState({ operations: {} });
  vi.mocked(timelineApi.listSpaceExecutions).mockReset().mockResolvedValue(page(0));
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

  it('stops once the last execution ends and the Space\'s document records it, without polling', async () => {
    vi.mocked(timelineApi.listSpaceExecutions).mockResolvedValue(page(1));
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'web_animation'), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
    vi.mocked(timelineApi.listSpaceExecutions).mockResolvedValue(page(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current).toBe(true);
    act(() => { recordChange('2-0'); });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('starts spinning at once when the Space\'s document records a new execution', async () => {
    const { wrapper } = provider();
    const { result } = renderHook(() => useSpaceTaskStatus(PROJECT, SPACE, 'web_animation'), { wrapper });
    await waitFor(() => expect(timelineApi.listSpaceExecutions).toHaveBeenCalled());
    expect(result.current).toBe(false);
    vi.mocked(timelineApi.listSpaceExecutions).mockResolvedValue(page(1));
    act(() => { recordChange('1-0'); });
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
