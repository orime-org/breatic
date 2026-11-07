// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The reads behind the execution list, web-clip resolution and preview (inner#1711 design §7.3 "address", §9 read
 * table).
 *
 * The execution list and the web-source resolution live under `spaceTasksQueryKey(projectId, spaceId)`, so the
 * page's Space-task signal (`use-space-tasks-refresh.ts`) refetches both. The resolution asks only for the ids the
 * document's web copies reference, refetches when that set changes, and polls while an execution it resolved is
 * unfinished. A preview address is fetched once per mount, outside that key, and never on window focus.
 */

import * as React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineClip, TimelineDocumentV1 } from '@breatic/shared';
import { spaceTasksQueryKey } from '@web/data/api/scene';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { timelineExecutionsQueryKey, useTimelineExecutions } from '@web/spaces/timeline/use-timeline-executions';
import { useTimelineWebResolution } from '@web/spaces/timeline/use-timeline-web-resolution';
import { useWebAnimationPreviewUrl } from '@web/spaces/timeline/use-web-animation-preview-url';
import { MAIN, V2, V3, cid, clip, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  EXEC_DONE, EXEC_RUNNING, RESOLUTION, SRC_A, SRC_B, boundTo, waitingFor, webClip,
} from '@web/data/yjs/__tests__/timeline-web-fixtures';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return {
    ...actual,
    timelineApi: { ...actual.timelineApi, listExecutions: vi.fn(), resolveWebSources: vi.fn(), previewUrl: vi.fn() },
  };
});

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';
const REFRESH_MS = 10_000;
const clients: QueryClient[] = [];

/**
 * A fresh cache and a wrapper providing it.
 * @returns Both.
 * @throws {never} Never.
 */
function provider(): { client: QueryClient; wrapper: (props: { children: React.ReactNode }) => React.JSX.Element } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return { client, wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}

/**
 * A document holding these clips.
 * @param clips - The clips.
 * @returns The document.
 * @throws {Error} When the fixture is invalid.
 */
function docWith(clips: TimelineClip[]): TimelineDocumentV1 {
  return timeline(clips);
}

beforeEach(() => {
  vi.mocked(timelineApi.listExecutions).mockReset().mockResolvedValue([]);
  vi.mocked(timelineApi.resolveWebSources).mockReset().mockResolvedValue(RESOLUTION);
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: 'https://preview.example/a/index.html' });
});

afterEach(() => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.clear();
  focusManager.setFocused(undefined);
});

describe('useTimelineExecutions', () => {
  it('keeps the list under the Space-task key, so the page signal refetches it', async () => {
    expect(timelineExecutionsQueryKey(PROJECT, SPACE).slice(0, 3)).toEqual([...spaceTasksQueryKey(PROJECT, SPACE)]);
    const { client, wrapper } = provider();
    const hook = renderHook(() => useTimelineExecutions(PROJECT, SPACE), { wrapper });
    await waitFor(() => expect(hook.result.current.data).toEqual([]));
    expect(timelineApi.listExecutions).toHaveBeenCalledWith(PROJECT, SPACE, expect.any(AbortSignal));
    await act(async () => { await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) }); });
    expect(timelineApi.listExecutions).toHaveBeenCalledTimes(2);
  });
});

describe('useTimelineWebResolution', () => {
  it('asks only for the ids the document web copies reference, without duplicates', async () => {
    const { wrapper } = provider();
    const doc = docWith([clip(cid(9), MAIN, 0, 10), webClip(cid(1), V2, 0, 10, boundTo(SRC_A)), webClip(cid(2), V3, 0, 10, boundTo(SRC_A)), webClip(cid(3), V2, 20, 10, waitingFor(EXEC_RUNNING))]);
    const hook = renderHook(() => useTimelineWebResolution(PROJECT, SPACE, doc, REFRESH_MS), { wrapper });
    await waitFor(() => expect(hook.result.current).toEqual(RESOLUTION));
    expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(1);
    const [projectId, ids] = vi.mocked(timelineApi.resolveWebSources).mock.calls[0] ?? [];
    expect(projectId).toBe(PROJECT);
    expect(ids).toEqual({ sourceIds: [SRC_A], executionIds: [EXEC_RUNNING] });
  });

  it('asks nothing and resolves nothing when the document has no web copy', () => {
    const { wrapper } = provider();
    const hook = renderHook(() => useTimelineWebResolution(PROJECT, SPACE, docWith([clip(cid(9), MAIN, 0, 10)]), REFRESH_MS), { wrapper });
    expect(hook.result.current).toEqual({ sources: {}, executions: {} });
    expect(timelineApi.resolveWebSources).not.toHaveBeenCalled();
  });

  it('refetches when the referenced set changes, and not when copies only move', async () => {
    const { wrapper } = provider();
    const first = docWith([webClip(cid(1), V2, 0, 10, boundTo(SRC_A))]);
    const hook = renderHook(({ doc }) => useTimelineWebResolution(PROJECT, SPACE, doc, REFRESH_MS), { wrapper, initialProps: { doc: first } });
    await waitFor(() => expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(1));
    hook.rerender({ doc: docWith([webClip(cid(1), V2, 30, 10, boundTo(SRC_A))]) });
    hook.rerender({ doc: docWith([webClip(cid(1), V2, 30, 10, boundTo(SRC_A)), webClip(cid(2), V3, 0, 10, boundTo(SRC_A))]) });
    await act(async () => { await Promise.resolve(); });
    expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(1);
    hook.rerender({ doc: docWith([webClip(cid(1), V2, 30, 10, boundTo(SRC_A)), webClip(cid(2), V3, 0, 10, boundTo(SRC_B))]) });
    await waitFor(() => expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(2));
    expect(vi.mocked(timelineApi.resolveWebSources).mock.calls[1]?.[1]).toEqual({ sourceIds: [SRC_A, SRC_B].sort(), executionIds: [] });
  });

  it('is refetched by the page Space-task signal', async () => {
    const { client, wrapper } = provider();
    renderHook(() => useTimelineWebResolution(PROJECT, SPACE, docWith([webClip(cid(1), V2, 0, 10)]), REFRESH_MS), { wrapper });
    await waitFor(() => expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(1));
    await act(async () => { await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) }); });
    expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(2);
  });

  it('polls while a resolved execution is unfinished and stops once every one has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(timelineApi.resolveWebSources)
      .mockResolvedValueOnce({ sources: {}, executions: { [EXEC_RUNNING]: RESOLUTION.executions[EXEC_RUNNING]! } })
      .mockResolvedValue({ sources: {}, executions: { [EXEC_RUNNING]: { ...RESOLUTION.executions[EXEC_RUNNING]!, status: 'failed' } } });
    const { wrapper } = provider();
    renderHook(() => useTimelineWebResolution(PROJECT, SPACE, docWith([webClip(cid(1), V2, 0, 10, waitingFor(EXEC_RUNNING))]), REFRESH_MS), { wrapper });
    await waitFor(() => expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS); });
    await waitFor(() => expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS * 3); });
    expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(2);
  });

  it('does not poll when every resolved execution has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { wrapper } = provider();
    renderHook(() => useTimelineWebResolution(PROJECT, SPACE, docWith([webClip(cid(1), V2, 0, 10, waitingFor(EXEC_DONE))]), REFRESH_MS), { wrapper });
    await waitFor(() => expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_MS * 3); });
    expect(timelineApi.resolveWebSources).toHaveBeenCalledTimes(1);
  });
});

describe('useWebAnimationPreviewUrl', () => {
  it('fetches one address per mount and not again on focus or on the Space-task signal', async () => {
    const { client, wrapper } = provider();
    const hook = renderHook(() => useWebAnimationPreviewUrl(PROJECT, SRC_A), { wrapper });
    await waitFor(() => expect(hook.result.current.url).toBe('https://preview.example/a/index.html'));
    expect(timelineApi.previewUrl).toHaveBeenCalledWith(PROJECT, SRC_A, expect.any(AbortSignal));
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await act(async () => { await client.invalidateQueries({ queryKey: spaceTasksQueryKey(PROJECT, SPACE) }); });
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);
  });

  it('fetches a new address when mounted again', async () => {
    const { wrapper } = provider();
    const first = renderHook(() => useWebAnimationPreviewUrl(PROJECT, SRC_A), { wrapper });
    await waitFor(() => expect(first.result.current.url).not.toBeNull());
    first.unmount();
    vi.mocked(timelineApi.previewUrl).mockResolvedValue({ url: 'https://preview.example/b/index.html' });
    const second = renderHook(() => useWebAnimationPreviewUrl(PROJECT, SRC_A), { wrapper });
    await waitFor(() => expect(second.result.current.url).toBe('https://preview.example/b/index.html'));
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2);
  });

  it('reports a failed request and fetches a fresh address on refresh', async () => {
    vi.mocked(timelineApi.previewUrl).mockRejectedValueOnce(new Error('404'));
    const { wrapper } = provider();
    const hook = renderHook(() => useWebAnimationPreviewUrl(PROJECT, SRC_A), { wrapper });
    await waitFor(() => expect(hook.result.current.failed).toBe(true));
    expect(hook.result.current.url).toBeNull();
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.url).toBe('https://preview.example/a/index.html'));
    expect(hook.result.current.failed).toBe(false);
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2);
  });
});
