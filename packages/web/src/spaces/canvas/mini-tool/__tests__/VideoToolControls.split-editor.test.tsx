// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 split panel (canvas design §4 split row: cuts on the time strip, add / move / type / delete, duplicate, order and
 * 0 / end checks, segment preview and the count; demo 2026-10-23-1306-video-tools main.tsx split branch, video-controls.tsx
 * CutEditor and PlaybackStrip; frames-split §10.6 ledger line only while the frame table is not usable).
 *
 * Fixture: a 5 s source at 25 fps (timescale 100, 125 frames of 4 ticks), so cuts snap to multiples of 0.04 s.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { MiniToolAnalysisRecord, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls, type VideoToolControlsProps } from '../video/VideoToolControls';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const common = { version: 1 as const, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [] };
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };

/**
 * A split draft with these cuts.
 * @param cuts - The stored cuts.
 * @returns The draft.
 */
function draftWith(cuts: number[]): VideoToolDraftById['video.split'] {
  return { ...common, params: { cuts } };
}

/**
 * Renders the split panel with defaults the test can override.
 * @param overrides - Props to change.
 * @returns The change handler and the rerender.
 */
function mount(overrides: Partial<VideoToolControlsProps> = {}): { onChange: ReturnType<typeof vi.fn>; rerender: (next: Partial<VideoToolControlsProps>) => void } {
  const onChange = vi.fn();
  const props = (next: Partial<VideoToolControlsProps>): VideoToolControlsProps => ({ toolId: 'video.split', draft: draftWith([1, 3]), onChange, analyses: [], frameTable, presentedTime: 1.25, disabled: false, pickingSlot: null,
    inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(), onSeek: vi.fn(), ...overrides, ...next });
  const view = render(<VideoToolControls {...props({})} />);
  return { onChange, rerender: (next) => view.rerender(<VideoToolControls {...props(next)} />) };
}

/**
 * Gives the strip's track a fixed on-screen box, 200 px for 5 s (40 px a second).
 * @throws {never} Never.
 */
function layOutTrack(): void {
  screen.getByTestId('video-playback-track').getBoundingClientRect = () => ({ left: 100, top: 0, width: 200, height: 48, right: 300, bottom: 48, x: 100, y: 0, toJSON: () => ({}) });
}

/** The scene detection record of this draft, completed or failed. */
function sceneRecord(status: 'completed' | 'failed'): MiniToolAnalysisRecord {
  const identity = {
    schemaVersion: 1 as const, draftId: common.draftId, revision: common.revision, analysisRunId: '80000000-0000-4000-8000-000000000003', acceptedAt: '2026-10-24T00:00:00.000001Z',
    binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: source.canonicalURL, kind: 'video' as const, mediaInfo: source.mediaInfo },
    analysisInput: { schemaVersion: 1 as const, sourceURL: source.canonicalURL, kind: 'scene_cuts' as const, range: { start: 0, end: 5 }, profile: { id: 'scenes', version: '1', weightsHash: null, params: {} } },
    inputFingerprint: 'b'.repeat(64),
  };
  return status === 'failed'
    ? { ...identity, kind: 'scene_cuts', status, artifactUnavailable: false, error: { code: 'failed' }, usage: [], result: null }
    : { ...identity, kind: 'scene_cuts', status, artifactUnavailable: false, error: null, usage: [], result: { ...identity, kind: 'scene_cuts', timeBase: { numerator: 1, denominator: 100 }, frameCount: 125, cuts: [{ frameIndex: 25, pts: 1, detectionScore: 0.9 }] } };
}

beforeEach(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

describe('split panel rows (demo main.tsx split branch)', () => {
  it('puts Detect above the time strip and the cut editor', () => {
    mount();
    const detect = screen.getByTestId('video-detect-scenes');
    expect(detect.compareDocumentPosition(screen.getByTestId('video-playback-strip')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detect.compareDocumentPosition(screen.getByTestId('video-cut-count')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps only Detect while the frame table is not usable', () => {
    mount({ frameTable: null });
    expect(screen.getByTestId('video-detect-scenes')).toBeInTheDocument();
    for (const id of ['video-playback-strip', 'video-cut-count', 'video-cut-0', 'video-segment-0', 'video-cut-handle-0']) expect(screen.queryByTestId(id)).toBeNull();
  });
});

describe('cut handles on the filmstrip (demo PlaybackStrip cuts)', () => {
  it('draws one numbered handle per cut on the strip and no separate slider', () => {
    mount();
    const track = screen.getByTestId('video-playback-track');
    expect(track.contains(screen.getByTestId('video-cut-handle-0'))).toBe(true);
    expect(screen.getByTestId('video-cut-handle-0').style.left).toBe('20%');
    expect(screen.getByTestId('video-cut-handle-1').style.left).toBe('60%');
    expect(screen.getByTestId('video-cut-handle-1')).toHaveTextContent('2');
    expect(document.querySelectorAll('[role=slider]')).toHaveLength(0);
  });

  it('moves a dragged handle and commits once, snapped to a frame start, without seeking', () => {
    const onSeek = vi.fn();
    const { onChange } = mount({ onSeek });
    layOutTrack();
    const handle = screen.getByTestId('video-cut-handle-0');
    fireEvent.pointerDown(handle, { button: 0, clientX: 140, pointerId: 1 });
    expect(handle).toHaveFocus();
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
    expect(screen.getByTestId('video-cut-handle-0').style.left).toBe('50%');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { clientX: 200, pointerId: 1 });
    expect(onChange).toHaveBeenCalledOnce();
    const cuts = (onChange.mock.calls[0]![0] as VideoToolDraftById['video.split']).params.cuts;
    expect(cuts).toHaveLength(2);
    expect(cuts[0]).toBeCloseTo(2.48, 6);
    expect(cuts[1]).toBe(3);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('removes a focused handle with Delete or Backspace', () => {
    const { onChange } = mount();
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-0'), { key: 'Delete' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ params: { cuts: [3] } }));
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-1'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ params: { cuts: [1] } }));
  });

  it('moves a focused handle one frame with the arrow keys', () => {
    const { onChange } = mount();
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-0'), { key: 'ArrowRight' });
    const cuts = (onChange.mock.calls[0]![0] as VideoToolDraftById['video.split']).params.cuts;
    expect(cuts[0]).toBeCloseTo(1.04, 6);
    expect(cuts[1]).toBe(3);
  });
});

describe('strip clock (demo PlaybackStrip)', () => {
  it('seeks on a strip press and shows the playhead and the start, current and end times', () => {
    const onSeek = vi.fn();
    mount({ onSeek });
    layOutTrack();
    fireEvent.pointerDown(screen.getByTestId('video-playback-track'), { button: 0, clientX: 200 });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(2.5);
    expect(screen.getByTestId('video-playback-head').style.left).toBe('25%');
    expect(screen.getByTestId('video-playback-times').textContent).toBe('0.00 s1.25 s5.00 s');
  });
});

describe('cut rows and count (canvas design §4 split row)', () => {
  it('lists the normalized cuts, sorted, unique and inside the video, numbered like the handles', () => {
    mount({ draft: draftWith([3, 1, 1.01, 7]) });
    expect(screen.getByTestId('video-cut-0')).toHaveValue('1');
    expect(screen.getByTestId('video-cut-1')).toHaveValue('3');
    expect(screen.queryByTestId('video-cut-2')).toBeNull();
    expect(screen.queryByTestId('video-cut-handle-2')).toBeNull();
  });

  it('refuses a typed cut at or below 0 and at or past the end', () => {
    const { onChange } = mount();
    const input = screen.getByTestId('video-cut-0');
    for (const value of ['0', '-1', '5', '6']) {
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
    }
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: { cuts: [2, 3] } }));
  });

  it('reads the number of cut points and segments', () => {
    const { rerender } = mount();
    expect(screen.getByTestId('video-cut-count')).toHaveTextContent('2 cut points · 3 segments');
    rerender({ draft: draftWith([1]) });
    expect(screen.getByTestId('video-cut-count')).toHaveTextContent('1 cut point · 2 segments');
    rerender({ draft: draftWith([]) });
    expect(screen.getByTestId('video-cut-count')).toHaveTextContent('0 cut points · 1 segment');
  });

  it('enables Add at cursor only where it would make a new cut', () => {
    const { onChange, rerender } = mount({ presentedTime: 1.02 });
    expect(screen.getByTestId('video-add-cut')).toBeDisabled();
    rerender({ presentedTime: 0 });
    expect(screen.getByTestId('video-add-cut')).toBeDisabled();
    rerender({ presentedTime: null });
    expect(screen.getByTestId('video-add-cut')).toBeDisabled();
    rerender({ presentedTime: 2 });
    expect(screen.getByTestId('video-add-cut')).toBeEnabled();
    fireEvent.click(screen.getByTestId('video-add-cut'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: { cuts: [1, 2, 3] } }));
  });
});

describe('segment preview (canvas design §4 split row preview; demo CutEditor)', () => {
  it('sizes one numbered button per segment by its share of the duration', () => {
    mount();
    expect(['0', '1', '2'].map((index) => screen.getByTestId(`video-segment-${index}`).textContent)).toEqual(['1', '2', '3']);
    expect(['0', '1', '2'].map((index) => screen.getByTestId(`video-segment-${index}`).style.flexGrow)).toEqual(['1', '2', '2']);
    expect(screen.queryByTestId('video-segment-3')).toBeNull();
  });

  it('plays exactly that range, shows it with Stop preview, and stops on press', async () => {
    const stop = vi.fn();
    let finish: () => void = () => undefined;
    const onPlayRange = vi.fn(() => ({ stop, done: new Promise<void>((resolve) => { finish = resolve; }) }));
    mount({ onPlayRange });
    fireEvent.click(screen.getByTestId('video-segment-1'));
    expect(onPlayRange).toHaveBeenCalledExactlyOnceWith(1, 3);
    expect(screen.getByTestId('video-segment-preview')).toHaveTextContent('Preview · 1.00 s – 3.00 s');
    fireEvent.click(screen.getByRole('button', { name: 'Stop preview' }));
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => { finish(); await Promise.resolve(); });
    expect(screen.queryByTestId('video-segment-preview')).toBeNull();
  });

  it('says the media is unavailable when the player refuses to play', async () => {
    const onPlayRange = vi.fn(() => ({ stop: vi.fn(), done: Promise.reject(new Error('NotAllowedError')) }));
    mount({ onPlayRange });
    await act(async () => { fireEvent.click(screen.getByTestId('video-segment-0')); await Promise.resolve(); });
    expect(screen.getByText(t('canvas.miniTool.videoUI.mediaError'))).toBeInTheDocument();
    expect(screen.queryByTestId('video-segment-preview')).toBeNull();
  });
});

describe('a failed scene detection (canvas design §4; demo main.tsx run-error)', () => {
  it('shows the detection failure with Retry, which detects again', () => {
    const onAnalyse = vi.fn();
    mount({ analyses: [sceneRecord('failed')], onAnalyse });
    const row = screen.getByTestId('video-detection-error');
    expect(row).toHaveTextContent('Detection failed. Try detecting scenes again.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAnalyse).toHaveBeenCalledExactlyOnceWith('scene_cuts');
  });

  it('shows no failure after a completed detection', () => {
    mount({ analyses: [sceneRecord('completed')] });
    expect(screen.queryByTestId('video-detection-error')).toBeNull();
  });
});
