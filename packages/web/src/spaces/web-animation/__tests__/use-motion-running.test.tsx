// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whether a Motion Space has a run in progress (#1490 design §8.3) is read from the same in-progress list the open
 * Space shows, so the tab's mark and the Space's list come from one request; nothing polls it (design §4.7).
 */

import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { useMotionLists } from '@web/spaces/web-animation/use-motion-lists';
import { useMotionRunning } from '@web/spaces/web-animation/use-motion-running';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listSpaceExecutions: vi.fn(), limits: vi.fn() } };
});

const PROJECT = '60000000-0000-4000-8000-000000000001';
const SPACE = '70000000-0000-4000-8000-000000000001';

afterEach(() => { vi.mocked(timelineApi.listSpaceExecutions).mockReset(); });

describe('useMotionRunning', () => {
  it('shares one in-progress request with the open Space\'s list, and says a run is in progress', async () => {
    vi.mocked(timelineApi.limits).mockReturnValue(new Promise(() => {}));
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async (params: { group?: string; scope?: string }) => (
      { rows: [], nextCursor: null, totals: { running: params.scope === 'space' && params.group === 'running' ? 1 : 0, succeeded: 0, failed: 0 } }
    ) as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => ({ running: useMotionRunning(PROJECT, SPACE, true), lists: useMotionLists(PROJECT, SPACE) }), { wrapper });
    await waitFor(() => expect(hook.result.current.running).toBe(true));
    await waitFor(() => expect(hook.result.current.lists.running.own.isSuccess).toBe(true));
    const runningReads = vi.mocked(timelineApi.listSpaceExecutions).mock.calls.filter(([params]) => params.scope === 'space' && params.group === 'running');
    expect(runningReads).toHaveLength(1);
  });

  it('reads the in-progress list once while a run is in progress, with no polling', async () => {
    vi.mocked(timelineApi.listSpaceExecutions).mockImplementation(async () => (
      { rows: [{ id: 'r1' }], nextCursor: null, totals: { running: 1, succeeded: 0, failed: 0 } }
    ) as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useMotionRunning(PROJECT, SPACE, true), { wrapper });
    await waitFor(() => expect(hook.result.current).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(vi.mocked(timelineApi.listSpaceExecutions)).toHaveBeenCalledTimes(1);
  });
});
