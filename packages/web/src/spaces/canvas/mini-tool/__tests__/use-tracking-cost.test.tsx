// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Canvas design §4 erase row: beside "Track selection" the estimate shows before tracking, and once the current selection is
 * tracked it gives way to what that tracking used, which arrives only when its charge commits (`usage`).
 */
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MiniToolAnalysisRecord, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { useTrackingCost, type TrackingCostFacts } from '../video/use-tracking-cost';
import { createVideoToolDraft } from '../video/video-tool-edit';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://assets.example.test/canonical.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const initial = createVideoToolDraft('video.erase', source);
const draft: VideoToolDraftById['video.erase'] = { ...initial, params: { ...initial.params, range: { start: 0, end: 3 }, region: { box: { x: 0.3, y: 0.2, width: 0.3, height: 0.6 }, points: [] } } };
const facts: TrackingCostFacts = { projectId: '01000000-0000-4000-8000-000000000011', spaceId: '02000000-0000-4000-8000-000000000011', nodeId: source.nodeId, draft,
  frameTable: { schemaVersion: 1, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] },
  presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } }, presentedTime: 0, tracking: undefined, debounceMs: 0 };
const tracked = (usage: MiniToolAnalysisRecord['usage']): MiniToolAnalysisRecord => ({ status: 'completed', usage } as MiniToolAnalysisRecord);

describe('useTrackingCost', () => {
  it('drops the estimate once the selection is tracked, and shows the use once it is billed', async () => {
    vi.spyOn(miniToolAnalysesApi, 'quote').mockResolvedValue({ credits: 8.5 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook((props: TrackingCostFacts) => useTrackingCost(props), { wrapper, initialProps: facts });
    await waitFor(() => expect(view.result.current).toEqual({ estimate: formatCreditAmount(8.5) }));
    view.rerender({ ...facts, tracking: tracked([]) });
    expect(view.result.current).toEqual({});
    view.rerender({ ...facts, tracking: tracked([{ credits: 6.25 }]) });
    expect(view.result.current).toEqual({ actual: formatCreditAmount(6.25) });
  });
});
