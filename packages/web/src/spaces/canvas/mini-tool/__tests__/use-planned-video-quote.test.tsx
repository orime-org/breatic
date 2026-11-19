// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The footer quote asks once the priced request has held still for `quote_debounce_ms`, not per keystroke (the quote route is
 * rate limited), and keeps the last price on screen while the next one settles.
 */
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { miniToolsApi } from '@web/data/api/mini-tools';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { usePlannedVideoQuote } from '../video/use-planned-video-quote';
import { createVideoToolDraft } from '../video/video-tool-edit';
import type { PlannedVideoFacts } from '../start-planned-video-run';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://assets.example.test/canonical.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const initial = createVideoToolDraft('video.expand', source) as VideoToolDraftById['video.expand'];
const facts: PlannedVideoFacts = { projectId: '01000000-0000-4000-8000-000000000011', spaceId: '02000000-0000-4000-8000-000000000011',
  presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } }, analysisRefs: [] };
const typed = (prompt: string): VideoToolDraftById['video.expand'] => ({ ...initial, params: { ...initial.params, frame: { x: -0.25, y: 0, width: 1.5, height: 1 }, prompt } });

/**
 * Renders the hook over a fresh query client.
 * @returns The hook view.
 */
function mount(): ReturnType<typeof renderHook<ReturnType<typeof usePlannedVideoQuote>, { prompt: string }>> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ prompt }: { prompt: string }) => usePlannedVideoQuote('video.expand', typed(prompt), facts, 300), { wrapper, initialProps: { prompt: 'a' } });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('usePlannedVideoQuote debounce', () => {
  it('quotes the last request once the edits hold still, and keeps the last price while the next settles', async () => {
    const quote = vi.spyOn(miniToolsApi, 'quotePlannedVideoRun').mockResolvedValueOnce({ credits: 4 }).mockResolvedValueOnce({ credits: 6 });
    const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(quote).toHaveBeenCalledTimes(1);
    expect(view.result.current.text).toBe(formatCreditAmount(4));
    for (const prompt of ['ab', 'abc', 'abcd']) {
      view.rerender({ prompt });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(quote).toHaveBeenCalledTimes(1);
    expect(view.result.current.text).toBe(formatCreditAmount(4));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(quote).toHaveBeenCalledTimes(2);
    // The answer reaches the hook on React Query's next notify tick.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect((quote.mock.calls[1]![0].draft as VideoToolDraftById['video.expand']).params.prompt).toBe('abcd');
    expect(view.result.current.text).toBe(formatCreditAmount(6));
  });
});
