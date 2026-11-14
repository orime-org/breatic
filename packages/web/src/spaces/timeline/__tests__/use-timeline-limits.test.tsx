// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The preview sync thresholds web plays with (#1410 design §6.4): before the Timeline limits arrive the preview uses
 * TIMELINE_PREVIEW_DEFAULTS, the same constant core's config defaults come from; afterwards the configured values.
 */

import * as React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TIMELINE_PREVIEW_DEFAULTS, type TimelineClientLimits } from '@breatic/shared';
import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { useTimelinePreviewLimits } from '@web/spaces/timeline/use-timeline-limits';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, limits: vi.fn() } };
});

const PROJECT = '60000000-0000-4000-8000-000000000001';
const CONFIGURED: TimelineClientLimits['preview'] = {
  driftSteerSeconds: 0.02, driftHardSyncSeconds: 0.4, driftCatastrophicSeconds: 2, resumeSeekSeconds: 0.1, driftSteerRate: 0.05,
};
const clients: QueryClient[] = [];

/**
 * A wrapper providing a fresh query cache.
 * @returns The wrapper.
 * @throws {never} Never.
 */
function wrapper(): (props: { children: React.ReactNode }) => React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.mocked(timelineApi.limits).mockReset();
});

describe('useTimelinePreviewLimits (#1410 design §6.4)', () => {
  it('plays with TIMELINE_PREVIEW_DEFAULTS while the Timeline limits have not arrived', () => {
    vi.mocked(timelineApi.limits).mockReturnValue(new Promise<TimelineClientLimits>(() => {}));
    const { result } = renderHook(() => useTimelinePreviewLimits(PROJECT), { wrapper: wrapper() });
    expect(result.current).toEqual({
      driftSteerSeconds: 0.04, driftHardSyncSeconds: 0.5, driftCatastrophicSeconds: 3, resumeSeekSeconds: 0.15, driftSteerRate: 0.03,
    });
    expect(result.current).toEqual(TIMELINE_PREVIEW_DEFAULTS);
  });

  it('switches to the configured values once the limits arrive', async () => {
    vi.mocked(timelineApi.limits).mockResolvedValue({
      defaults: { width: 1920, height: 1080, fps: { num: 24, den: 1 } },
      assets: { pageSize: 50, pageMax: 100 },
      webAnimation: { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9'], playerLoadTimeoutMs: 15_000, sourceRefreshIntervalMs: 10_000 },
      preview: CONFIGURED,
    });
    const { result } = renderHook(() => useTimelinePreviewLimits(PROJECT), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toEqual(CONFIGURED));
  });
});
