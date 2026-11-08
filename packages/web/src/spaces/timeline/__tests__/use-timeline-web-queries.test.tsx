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

describe('useWebAnimationPreviewUrl sharing one address per source version (inner#1711 design §7.3 "address")', () => {
  // The Timeline limits' signature validity and player load timeout; a new mount reuses an address until 8 s after
  // its request was sent.
  const SHARING = { previewTokenTtlMs: 10_000, playerLoadTimeoutMs: 2_000 };
  const T0 = 1_000_000;
  const URL_1 = 'https://preview.example/one/index.html';
  const URL_2 = 'https://preview.example/two/index.html';
  let sourceSerial = 0;

  /**
   * A source version no other case has used, so the page-wide shared address of one case never reaches another.
   * @returns Its id.
   * @throws {never} Never.
   */
  function freshSource(): string {
    sourceSerial += 1;
    return `80000000-0000-4000-8000-0000000003${String(sourceSerial).padStart(2, '0')}`;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  it('shares one address across mounts from when its request was sent until its validity less the load timeout, then asks again', async () => {
    const source = freshSource();
    let answer: (value: { url: string }) => void = () => {};
    vi.mocked(timelineApi.previewUrl).mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
      .mockResolvedValue({ url: URL_2 });
    const { wrapper } = provider();
    const first = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    // The answer arrives half a second after the request; the window counts from the request.
    vi.setSystemTime(T0 + 500);
    await act(async () => { answer({ url: URL_1 }); await Promise.resolve(); });
    await waitFor(() => expect(first.result.current.url).toBe(URL_1));
    first.unmount();

    vi.setSystemTime(T0 + 7_999);
    const second = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(second.result.current.url).toBe(URL_1));
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 8_000);
    const third = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(third.result.current.url).toBe(URL_2));
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2);
    // A page already loaded keeps the address it loaded with.
    expect(second.result.current.url).toBe(URL_1);
  });

  it('shares one request still in flight with a second mount, and both get its address', async () => {
    const source = freshSource();
    let answer: (value: { url: string }) => void = () => {};
    vi.mocked(timelineApi.previewUrl).mockReset()
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
      .mockResolvedValue({ url: URL_2 });
    const { wrapper } = provider();
    const first = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    vi.setSystemTime(T0 + 200);
    const second = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ url: URL_1 }); await Promise.resolve(); });
    await waitFor(() => expect(first.result.current.url).toBe(URL_1));
    await waitFor(() => expect(second.result.current.url).toBe(URL_1));
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);
  });

  it('keeps addresses of different source versions and Projects apart', async () => {
    const source = freshSource();
    const other = freshSource();
    vi.mocked(timelineApi.previewUrl).mockReset()
      .mockImplementation(async (projectId, sourceVersionId) => ({ url: `https://preview.example/${projectId}/${sourceVersionId}/index.html` }));
    const { wrapper } = provider();
    const a = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(a.result.current.url).not.toBeNull());
    const again = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(again.result.current.url).toBe(a.result.current.url));
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);
    const b = renderHook(() => useWebAnimationPreviewUrl(PROJECT, other, SHARING), { wrapper });
    await waitFor(() => expect(b.result.current.url).toBe(`https://preview.example/${PROJECT}/${other}/index.html`));
    const otherProject = '60000000-0000-4000-8000-000000000002';
    const c = renderHook(() => useWebAnimationPreviewUrl(otherProject, source, SHARING), { wrapper });
    await waitFor(() => expect(c.result.current.url).toBe(`https://preview.example/${otherProject}/${source}/index.html`));
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(3);
  });

  it('does not share when the validity is no longer than the load timeout, nor before the Timeline limits arrive', async () => {
    vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: URL_1 });
    const { wrapper } = provider();
    // Control: with a usable window two mounts share one request.
    const shared = freshSource();
    for (let mount = 0; mount < 2; mount += 1) {
      const hook = renderHook(() => useWebAnimationPreviewUrl(PROJECT, shared, SHARING), { wrapper });
      await waitFor(() => expect(hook.result.current.url).toBe(URL_1));
      hook.unmount();
    }
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);

    const tight = freshSource();
    for (let mount = 0; mount < 2; mount += 1) {
      const hook = renderHook(() => useWebAnimationPreviewUrl(PROJECT, tight, { previewTokenTtlMs: 2_000, playerLoadTimeoutMs: 2_000 }), { wrapper });
      await waitFor(() => expect(hook.result.current.url).toBe(URL_1));
      hook.unmount();
    }
    expect(vi.mocked(timelineApi.previewUrl).mock.calls.filter((call) => call[1] === tight)).toHaveLength(2);

    const unknown = freshSource();
    for (let mount = 0; mount < 2; mount += 1) {
      const hook = renderHook(() => useWebAnimationPreviewUrl(PROJECT, unknown, undefined), { wrapper });
      await waitFor(() => expect(hook.result.current.url).toBe(URL_1));
      hook.unmount();
    }
    expect(vi.mocked(timelineApi.previewUrl).mock.calls.filter((call) => call[1] === unknown)).toHaveLength(2);
  });

  it('replaces the shared address when a mount refreshes after its page failed to load', async () => {
    const source = freshSource();
    vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValueOnce({ url: URL_1 }).mockResolvedValue({ url: URL_2 });
    const { wrapper } = provider();
    const failing = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(failing.result.current.url).toBe(URL_1));
    vi.setSystemTime(T0 + 1_000);
    act(() => failing.result.current.refresh());
    await waitFor(() => expect(failing.result.current.url).toBe(URL_2));
    failing.unmount();

    vi.setSystemTime(T0 + 5_000);
    const next = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(next.result.current.url).toBe(URL_2));
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2);
  });

  it('does not share a refused request: a later mount within the window asks again', async () => {
    const source = freshSource();
    vi.mocked(timelineApi.previewUrl).mockReset().mockRejectedValueOnce(new Error('404')).mockResolvedValue({ url: URL_2 });
    const { wrapper } = provider();
    const refused = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(refused.result.current.failed).toBe(true));

    vi.setSystemTime(T0 + 1_000);
    const next = renderHook(() => useWebAnimationPreviewUrl(PROJECT, source, SHARING), { wrapper });
    await waitFor(() => expect(next.result.current.url).toBe(URL_2));
    expect(next.result.current.failed).toBe(false);
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2);
  });
});
