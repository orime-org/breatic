// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 approved demo main.tsx erase branch and video-controls.tsx PlaybackStrip range: the erase panel reads the
 * range on the playback strip with a two-thumb slider and its length, then the tracking status, then one row with the
 * selection modes and a clear icon on the left and the tracking cost and Track selection on the right, then the prompt;
 * a failed tracking is a bordered error block.
 */

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { MiniToolAnalysisRecord, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const draft: VideoToolDraftById['video.erase'] = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [],
  params: { range: { start: 25, end: 75 }, anchor: { frameIndex: 0 }, region: { box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }, points: [] }, trackingPrompt: '' },
};
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };

/**
 * Renders the erase controls.
 * @param overrides - Props to change.
 * @returns The container.
 */
function mount(overrides: Partial<React.ComponentProps<typeof VideoToolControls>> = {}): HTMLElement {
  return render(<VideoToolControls toolId='video.erase' draft={draft} analyses={[]} grid={grid} presentedTime={2} disabled={false} pickingSlot={null}
    inputNames={new Map()} onPick={vi.fn()} onAnalyse={vi.fn()} analysing={false} onEditTimeline={vi.fn()} onChange={vi.fn()} analysisCreditText='8' {...overrides} />).container;
}

describe('the erase range strip (D1)', () => {
  it('dims outside the range, outlines it and reads its length between its ends', () => {
    mount();
    expect(screen.getByTestId('video-playback-before').style.width).toBe('20%');
    expect(screen.getByTestId('video-playback-after').style.width).toBe('40%');
    expect(screen.getByTestId('video-playback-range').style).toMatchObject({ left: '20%', width: '40%' });
    expect(screen.getByTestId('video-playback-head')).toBeInTheDocument();
    const times = screen.getByTestId('video-playback-times').children;
    expect([...times].map((cell) => cell.textContent)).toEqual(['1.00 s', `${t('canvas.miniTool.videoUI.timeRange')} · 2.00 s`, '3.00 s']);
  });

  it('seeks when the strip is pressed', () => {
    const onSeek = vi.fn();
    mount({ onSeek });
    const track = screen.getByTestId('video-playback-track');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 48, width: 100, height: 48, toJSON: () => ({}) });
    fireEvent.pointerDown(track, { button: 0, clientX: 50 });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(2.5);
  });

  it('edits the range with a two-thumb slider under the strip and keeps the Start and End fields', () => {
    const onChange = vi.fn();
    mount({ onChange });
    const thumbs = screen.getAllByRole('slider');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]!.getAttribute('aria-valuenow')).toBe('1');
    expect(thumbs[1]!.getAttribute('aria-valuenow')).toBe('3');
    // Radix moves the thumb that last took focus; the strip shows seconds and the draft stores grid frames (§7.16).
    fireEvent.focus(thumbs[1]!);
    fireEvent.keyDown(thumbs[1]!, { key: 'End' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].params.range).toEqual({ start: 25, end: 125 });
    expect(screen.getByTestId('video-range-start')).toBeInTheDocument();
    expect(screen.getByTestId('video-range-end')).toBeInTheDocument();
  });
});

describe('the erase selection row (D2, D3)', () => {
  it('puts the modes and the clear icon left, the cost and Track selection right, under the status line, and the prompt last', () => {
    const container = mount();
    const row = screen.getByTestId('video-selection-row');
    const [left, right] = [...row.children];
    expect(left!.contains(screen.getByTestId('video-region-selection-rectangle'))).toBe(true);
    expect(left!.contains(screen.getByTestId('video-region-selection-point'))).toBe(true);
    expect(left!.contains(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.clearSelection') }))).toBe(true);
    expect(right!.contains(screen.getByText(t('canvas.miniTool.videoUI.trackingEstimate', { credits: '8' })))).toBe(true);
    expect(right!.contains(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.trackObject') }))).toBe(true);
    const status = screen.getByTestId('video-tracking-status');
    expect(status.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.lastElementChild).toBe(screen.getByPlaceholderText(t('canvas.miniTool.videoUI.trackingPrompt')));
  });

  it('marks the chosen mode', () => {
    mount({ regionSelection: 'point' });
    expect(screen.getByTestId('video-region-selection-point').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('video-region-selection-rectangle').getAttribute('aria-current')).toBe('false');
  });

  it('clears the selection with the clear icon', () => {
    const onChange = vi.fn();
    mount({ onChange });
    fireEvent.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.clearSelection') }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].params.region).toEqual({ box: null, points: [] });
  });

  it('disables the clear icon without a selection', () => {
    mount({ draft: { ...draft, params: { ...draft.params, region: { box: null, points: [] } } } });
    expect(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.clearSelection') })).toBeDisabled();
  });
});

describe('the erase tracking failure block (D8)', () => {
  it('is a bordered error block holding the text and Retry tracking', () => {
    const failed = { schemaVersion: 1, draftId: draft.draftId, revision: draft.revision, analysisRunId: '40000000-0000-4000-8000-000000000001', acceptedAt: '2026-11-07T00:00:00.000001Z',
      binding: { assetId: '50000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: source.canonicalURL, kind: 'video', mediaInfo: source.mediaInfo },
      analysisInput: { schemaVersion: 1, kind: 'tracked_mask', sourceURL: source.canonicalURL, profile: { id: 'sam3-video-rle', version: '1', weightsHash: null, params: {} }, range: draft.params.range, anchor: draft.params.anchor, region: draft.params.region, trackingPrompt: '' },
      inputFingerprint: 'b'.repeat(64), kind: 'tracked_mask', status: 'failed', result: null, error: { code: 'timeout', step: 'join' }, usage: [], artifactUnavailable: false,
    } as MiniToolAnalysisRecord;
    mount({ analyses: [failed] });
    const block = screen.getByTestId('video-tracking-failure');
    expect(block.className).toContain('border-status-error-border');
    expect(block.className).toContain('bg-status-error-bg');
    expect(block.textContent).toContain(t('canvas.miniTool.videoUI.trackingFailure.timeout'));
    expect(block.contains(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.retryTracking') }))).toBe(true);
  });
});
