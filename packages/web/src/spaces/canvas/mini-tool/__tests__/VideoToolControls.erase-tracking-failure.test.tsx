// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 execution design §10.3 code table and §10.8 copy rows: a failed tracking analysis shows one failure line chosen
 * by its stored `error.code` (`canvas.miniTool.videoUI.trackingFailure.<code>`), and a "Retry tracking" button
 * (`canvas.miniTool.videoUI.retryTracking`) only for the codes shared `trackedMaskRetryable` allows; pressing it hands the
 * failed record to `onRetryTracking`, which starts a new tracking run with its frozen input. §10.4: Bria takes no prompt, so the panel has no erase description box.
 */

import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { MiniToolAnalysisRecord, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const draft: VideoToolDraftById['video.erase'] = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [],
  params: { range: { start: 0, end: 3 }, anchor: { frameIndex: 0, pts: 0 }, region: { box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, points: [] }, trackingPrompt: '' },
};
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };

/**
 * A failed tracking analysis of the draft.
 * @param code - Its stored failure code.
 * @returns The record.
 */
function failed(code: string): MiniToolAnalysisRecord {
  const analysisInput = { schemaVersion: 1 as const, kind: 'tracked_mask' as const, sourceURL: source.canonicalURL, profile: { id: 'sam3-video-rle', version: '1', weightsHash: null, params: {} },
    range: draft.params.range, anchor: draft.params.anchor, region: draft.params.region, trackingPrompt: 'object' };
  return {
    schemaVersion: 1, draftId: draft.draftId, revision: draft.revision, analysisRunId: '40000000-0000-4000-8000-000000000001', acceptedAt: '2026-11-07T00:00:00.000001Z',
    binding: { assetId: '50000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: source.canonicalURL, kind: 'video', mediaInfo: source.mediaInfo },
    analysisInput, inputFingerprint: 'b'.repeat(64), kind: 'tracked_mask', status: 'failed', result: null, error: { code, step: code === 'model_rejected' ? 'track' : 'join' },
    usage: [], artifactUnavailable: false,
  };
}

/**
 * Renders the erase controls over one failed tracking analysis.
 * @param code - The stored failure code.
 * @param onAnalyse - The tracking entry.
 * @param onRetryTracking - The retry entry.
 * @returns Nothing.
 */
function mount(code: string, onAnalyse = vi.fn(), onRetryTracking = vi.fn()): void {
  render(<VideoToolControls toolId='video.erase' draft={draft} analyses={[failed(code)]} frameTable={frameTable} presentedTime={0} disabled={false} pickingSlot={null}
    inputNames={new Map()} onPick={vi.fn()} onAnalyse={onAnalyse} onRetryTracking={onRetryTracking} analysing={false} onEditTimeline={vi.fn()} onChange={vi.fn()} />);
}

describe('the erase tracking failure line (execution design §10.3)', () => {
  it.each([
    ['empty_foreground', false],
    ['model_rejected', false],
    ['tracking_output_mismatch', true],
    ['timeout', true],
    ['failed', true],
  ] as const)('shows the %s line, with Retry tracking only when it is retryable (%s)', (code, retryable) => {
    const [onAnalyse, onRetryTracking] = [vi.fn(), vi.fn()];
    mount(code, onAnalyse, onRetryTracking);
    expect(screen.getByText(t(`canvas.miniTool.videoUI.trackingFailure.${code}`))).toBeInTheDocument();
    const retry = screen.queryByRole('button', { name: t('canvas.miniTool.videoUI.retryTracking') });
    if (!retryable) { expect(retry).toBeNull(); return; }
    act(() => retry!.click());
    expect(onRetryTracking).toHaveBeenCalledExactlyOnceWith(failed(code));
    expect(onAnalyse).not.toHaveBeenCalled();
  });

  it('has no erase description box, only the tracking prompt', () => {
    mount('timeout');
    // The range's Start and End are numeric fields; the one text box besides them is the tracking prompt.
    const textBoxes = screen.getAllByRole('textbox').filter((box) => box.getAttribute('inputmode') !== 'decimal');
    expect(textBoxes).toEqual([screen.getByPlaceholderText(t('canvas.miniTool.videoUI.trackingPrompt'))]);
  });
});
