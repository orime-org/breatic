// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 split panel (canvas design §4 split row: cuts on the time strip, add / move / type / delete, duplicate, order and
 * 0 / end checks, segment preview and the count; demo 2026-10-23-1306-video-tools main.tsx split branch, video-controls.tsx
 * CutEditor and PlaybackStrip; frames-split §10.6: only Detect while the selected version's grid is not usable).
 *
 * Fixture: a selected version on a 25 fps grid of 125 frames (5 s). Cuts are stored as grid frame numbers (frames-split §10.7
 * split row) and shown as the seconds their frames start at, multiples of 0.04 s.
 */

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import { planVideoSplit, type MiniToolAnalysisRecord, type VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoNumericInput, VideoToolControls, type VideoToolControlsProps } from '../video/VideoToolControls';
import { frameIndexOfMediaTime } from '../../video-presentation/frame-grid-time';

// The real plan, spied on, so a test can count the whole plans the panel makes.
vi.mock('@breatic/shared/mini-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breatic/shared/mini-tools')>();
  return { ...actual, planVideoSplit: vi.fn(actual.planVideoSplit) };
});
import type { VideoPlaybackLiveClock } from '../video/VideoPlaybackStrip';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const common = { version: 1 as const, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [] };
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };

/**
 * A split draft with these cuts.
 * @param cuts - The stored cuts, grid frame numbers.
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
  const props = (next: Partial<VideoToolControlsProps>): VideoToolControlsProps => ({ toolId: 'video.split', draft: draftWith([25, 75]), onChange, analyses: [], grid, presentedTime: 1.25, disabled: false,
    onAnalyse: vi.fn(), analysing: false, onSeek: vi.fn(), ...overrides, ...next });
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
    analysisInput: { schemaVersion: 1 as const, sourceURL: source.canonicalURL, kind: 'scene_cuts' as const, range: { start: 0, end: 125 }, profile: { id: 'scenes', version: '1', weightsHash: null, params: {} } },
    inputFingerprint: 'b'.repeat(64),
  };
  return status === 'failed'
    ? { ...identity, kind: 'scene_cuts', status, artifactUnavailable: false, error: { code: 'failed' }, usage: [], result: null }
    : { ...identity, kind: 'scene_cuts', status, artifactUnavailable: false, error: null, usage: [], result: { ...identity, kind: 'scene_cuts', fps: grid.fps, frameCount: 125, cuts: [{ frameIndex: 25, detectionScore: 0.9 }] } };
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

  it('keeps only Detect while the grid is not usable', () => {
    mount({ grid: null });
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

  it('moves a dragged handle and commits the dragged position once, without seeking', () => {
    const onSeek = vi.fn();
    const { onChange } = mount({ onSeek });
    layOutTrack();
    const handle = screen.getByTestId('video-cut-handle-0');
    fireEvent.pointerDown(handle, { button: 0, clientX: 140, pointerId: 1 });
    expect(handle).toHaveFocus();
    // 2.5 s lies inside frame 62 (2.48 to 2.52 s), so the handle takes that frame's start and the stored cut is frame 62.
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
    expect(screen.getByTestId('video-cut-handle-0').style.left).toBe('49.6%');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { clientX: 209, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: { cuts: [62, 75] } }));
    expect(onSeek).not.toHaveBeenCalled();
  });

  it.each([
    ['past the end', 340, 4.96, 124],
    ['onto the end', 300, 4.96, 124],
    ['past the start', 40, 0.04, 1],
    ['onto the first frame', 101, 0.04, 1],
  ])('keeps a handle dragged %s one frame inside the video and commits it there', (_where, clientX, shown, cut) => {
    const { onChange } = mount({ draft: draftWith([50]) });
    layOutTrack();
    const handle = screen.getByTestId('video-cut-handle-0');
    fireEvent.pointerDown(handle, { button: 0, clientX: 180, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX, pointerId: 1 });
    expect(screen.getByTestId('video-cut-handle-0').style.left).toBe(`${String(shown * 100 / 5)}%`);
    fireEvent.pointerUp(handle, { clientX, pointerId: 1 });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: { cuts: [cut] } }));
  });

  it('leaves the cut where it is when a handle is only clicked to focus it', () => {
    const { onChange } = mount();
    layOutTrack();
    const handle = screen.getByTestId('video-cut-handle-0');
    fireEvent.pointerDown(handle, { button: 0, clientX: 149, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 149, pointerId: 1 });
    expect(handle).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    expect(handle.style.left).toBe('20%');
  });

  it('removes a focused handle with Delete or Backspace', () => {
    const { onChange } = mount();
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-0'), { key: 'Delete' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ params: { cuts: [75] } }));
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-1'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ params: { cuts: [25] } }));
  });

  it('moves a focused handle one frame with the arrow keys', () => {
    const { onChange } = mount();
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-0'), { key: 'ArrowRight' });
    const cuts = (onChange.mock.calls[0]![0] as VideoToolDraftById['video.split']).params.cuts;
    expect(cuts).toEqual([26, 75]);
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
    mount({ draft: draftWith([75, 25, 25, 0, 175]) });
    expect(screen.getByTestId('video-cut-0')).toHaveValue('1');
    expect(screen.getByTestId('video-cut-1')).toHaveValue('3');
    expect(screen.queryByTestId('video-cut-2')).toBeNull();
    expect(screen.queryByTestId('video-cut-handle-2')).toBeNull();
  });

  it('keeps the typed text and stores the typed number while a cut is typed key by key', () => {
    const changes: number[][] = [];
    /**
     * The split panel over a draft that takes every change, as the panel container does.
     * @returns The panel.
     */
    function Stateful(): React.JSX.Element {
      const [draft, setDraft] = React.useState(draftWith([25, 75]));
      return <VideoToolControls toolId='video.split' draft={draft} onChange={(next) => { const split = next as VideoToolDraftById['video.split']; changes.push(split.params.cuts); setDraft(split); }} analyses={[]} grid={grid} presentedTime={1.25} disabled={false} onAnalyse={vi.fn()} analysing={false} onSeek={vi.fn()} />;
    }
    render(<Stateful />);
    fireEvent.change(screen.getByTestId('video-cut-0'), { target: { value: '' } });
    let typed = '';
    for (const key of ['2', '.', '5', '5']) {
      typed += key;
      fireEvent.change(screen.getByTestId('video-cut-0'), { target: { value: `${(screen.getByTestId('video-cut-0') as HTMLInputElement).value}${key}` } });
      expect(screen.getByTestId('video-cut-0')).toHaveValue(typed);
    }
    // The typed 2.55 s lies inside frame 63 (2.52 to 2.56 s), which is the cut stored.
    expect(changes.at(-1)).toEqual([63, 75]);
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
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: { cuts: [50, 75] } }));
  });

  it('reads the number of cut points and segments', () => {
    const { rerender } = mount();
    expect(screen.getByTestId('video-cut-count')).toHaveTextContent('2 cut points · 3 segments');
    rerender({ draft: draftWith([25]) });
    expect(screen.getByTestId('video-cut-count')).toHaveTextContent('1 cut point · 2 segments');
    rerender({ draft: draftWith([]) });
    expect(screen.getByTestId('video-cut-count')).toHaveTextContent('0 cut points · 1 segment');
  });

  it('enables Add at cursor only where it would make a new cut', () => {
    // 1.01 s presents frame round(25.25) = 25, which already holds a cut (frames-split §4.3).
    const { onChange, rerender } = mount({ presentedTime: 1.01 });
    expect(screen.getByTestId('video-add-cut')).toBeDisabled();
    rerender({ presentedTime: 0 });
    expect(screen.getByTestId('video-add-cut')).toBeDisabled();
    rerender({ presentedTime: null });
    expect(screen.getByTestId('video-add-cut')).toBeDisabled();
    rerender({ presentedTime: 2 });
    expect(screen.getByTestId('video-add-cut')).toBeEnabled();
    fireEvent.click(screen.getByTestId('video-add-cut'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ params: { cuts: [25, 50, 75] } }));
  });
});

describe('segment preview (canvas design §4 split row preview; demo CutEditor)', () => {
  it('sizes one numbered button per segment by its share of the duration', () => {
    mount();
    expect(['0', '1', '2'].map((index) => screen.getByTestId(`video-segment-${index}`).textContent)).toEqual(['1', '2', '3']);
    // Frames 0–25, 25–75 and 75–125: one share to two to two.
    expect(['0', '1', '2'].map((index) => screen.getByTestId(`video-segment-${index}`).style.flexGrow)).toEqual(['25', '50', '50']);
    expect(screen.queryByTestId('video-segment-3')).toBeNull();
  });

  it('plays that segment from its first frame midpoint to its last frame midpoint, shows it with Stop preview, and stops on press', async () => {
    const stop = vi.fn();
    let finish: () => void = () => undefined;
    const onPlayRange = vi.fn(() => ({ stop, done: new Promise<void>((resolve) => { finish = resolve; }) }));
    mount({ onPlayRange });
    fireEvent.click(screen.getByTestId('video-segment-1'));
    // Frames 25 to 74 of the 25 fps grid: every frame jump goes to the frame midpoint (frames-split §4.3).
    expect(onPlayRange).toHaveBeenCalledExactlyOnceWith(25.5 / 25, 74.5 / 25);
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

/**
 * The split panel over a draft that takes every change under a new revision, as the panel container does.
 * @param props - The starting cuts, the presented time and the live clock.
 * @param props.cuts - The starting cuts, grid frame numbers.
 * @param props.presentedTime - The panel's presented time.
 * @param props.liveClock - The source player's live clock.
 * @param props.changes - Collects every stored cut list.
 * @returns The panel.
 */
function StatefulSplit(props: { cuts: number[]; presentedTime?: number | null; liveClock?: VideoPlaybackLiveClock; changes?: number[][]; invalid?: Set<string> }): React.JSX.Element {
  const [draft, setDraft] = React.useState(draftWith(props.cuts));
  const { invalid } = props;
  const onInvalidChange = React.useCallback((key: string, bad: boolean) => { if (bad) invalid?.add(key); else invalid?.delete(key); }, [invalid]);
  return <VideoToolControls toolId='video.split' draft={draft} onChange={(next) => { const split = next as VideoToolDraftById['video.split']; props.changes?.push(split.params.cuts); setDraft({ ...split, revision: crypto.randomUUID() }); }} analyses={[]} grid={grid} presentedTime={props.presentedTime ?? 1.25} liveClock={props.liveClock} disabled={false} onAnalyse={vi.fn()} analysing={false} onSeek={vi.fn()} onInvalidChange={onInvalidChange} />;
}

describe('an invalid cut row keeps blocking the run wherever it moves (web AGENTS "Inputs send what they show")', () => {
  it('reports the invalid row under its new position after leaving it reorders the rows', () => {
    const invalid = new Set<string>();
    render(<StatefulSplit cuts={[25, 75]} invalid={invalid} />);
    act(() => (screen.getByTestId('video-cut-0') as HTMLInputElement).focus());
    fireEvent.change(screen.getByTestId('video-cut-0'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('video-cut-0'), { target: { value: '' } });
    expect([...invalid]).toEqual(['video-cut-0']);
    act(() => (screen.getByTestId('video-cut-0') as HTMLInputElement).blur());
    expect(screen.getByTestId('video-cut-1')).toHaveValue('');
    expect([...invalid]).toEqual(['video-cut-1']);
  });

  it('reports the invalid row under its new position after another row is removed', () => {
    const invalid = new Set<string>();
    render(<StatefulSplit cuts={[50, 75, 100]} invalid={invalid} />);
    act(() => (screen.getByTestId('video-cut-2') as HTMLInputElement).focus());
    fireEvent.change(screen.getByTestId('video-cut-2'), { target: { value: '' } });
    const bin = screen.getAllByRole('button', { name: 'Remove' })[0]!;
    fireEvent.mouseDown(bin);
    fireEvent.click(bin);
    expect(screen.getByTestId('video-cut-1')).toHaveValue('');
    expect([...invalid]).toEqual(['video-cut-1']);
  });
});

describe('a numeric field reports what it shows', () => {
  it('writes a refused value once a changed limit accepts it, so the field and the draft agree', () => {
    const invalid = new Set<string>();
    const report = (key: string, bad: boolean): void => { if (bad) invalid.add(key); else invalid.delete(key); };
    const onChange = vi.fn();
    const view = render(<VideoNumericInput value={0} label='Start' testId='start' min={0} max={3} exclusiveMax disabled={false} onInvalidChange={report} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('start'), { target: { value: '4' } });
    expect(onChange).not.toHaveBeenCalled();
    expect([...invalid]).toEqual(['start']);
    view.rerender(<VideoNumericInput value={0} label='Start' testId='start' min={0} max={5} exclusiveMax disabled={false} onInvalidChange={report} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(4);
    expect([...invalid]).toEqual([]);
    expect(screen.getByTestId('start')).toHaveValue('4');
  });

  it('shows a stored value changed elsewhere and writes nothing back', () => {
    const onChange = vi.fn();
    const view = render(<VideoNumericInput value={2} label='Start' testId='start' min={0} max={5} disabled={false} onChange={onChange} />);
    view.rerender(<VideoNumericInput value={3} label='Start' testId='start' min={0} max={5} disabled={false} onChange={onChange} />);
    expect(screen.getByTestId('start')).toHaveValue('3');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a shown value that a changed limit makes invalid, and clears it when the limit allows it again', () => {
    const invalid = new Set<string>();
    const report = (key: string, bad: boolean): void => { if (bad) invalid.add(key); else invalid.delete(key); };
    const view = render(<VideoNumericInput value={2} label='In point' testId='in' min={0} max={5} disabled={false} onInvalidChange={report} onChange={vi.fn()} />);
    expect([...invalid]).toEqual([]);
    view.rerender(<VideoNumericInput value={2} label='In point' testId='in' min={0} max={1} disabled={false} onInvalidChange={report} onChange={vi.fn()} />);
    expect([...invalid]).toEqual(['in']);
    view.rerender(<VideoNumericInput value={2} label='In point' testId='in' min={0} max={5} disabled={false} onInvalidChange={report} onChange={vi.fn()} />);
    expect([...invalid]).toEqual([]);
  });
});

describe('typing a cut row in place (web AGENTS "Inputs send what they show")', () => {
  it('keeps every typed key in the typed row and the other row unchanged, then shows the rows ordered on blur without a write', () => {
    const changes: number[][] = [];
    render(<StatefulSplit cuts={[75, 100]} changes={changes} />);
    const row = screen.getByTestId('video-cut-1') as HTMLInputElement;
    act(() => row.focus());
    for (const typed of ['1', '1.', '1.5']) {
      fireEvent.change(screen.getByTestId('video-cut-1'), { target: { value: typed } });
      expect(screen.getByTestId('video-cut-1')).toHaveValue(typed);
      expect(screen.getByTestId('video-cut-0')).toHaveValue('3');
      expect(screen.getByTestId('video-cut-1')).toHaveFocus();
    }
    // 1.5 s lies inside frame 37 (1.48 to 1.52 s); while typing, the frames are stored in row order.
    expect(changes.at(-1)).toEqual([75, 37]);
    const written = changes.length;
    act(() => (screen.getByTestId('video-cut-1') as HTMLInputElement).blur());
    // Left, the rows show the stored frames in order, each at its frame start: frame 37 starts at 1.48 s (§10.7).
    expect(screen.getByTestId('video-cut-0')).toHaveValue('1.48');
    expect(screen.getByTestId('video-cut-1')).toHaveValue('3');
    expect(changes).toHaveLength(written);
  });

  it('commits a handle drag pressed right after typing a row that needs reordering', () => {
    const changes: number[][] = [];
    render(<StatefulSplit cuts={[75, 100]} changes={changes} />);
    layOutTrack();
    act(() => (screen.getByTestId('video-cut-1') as HTMLInputElement).focus());
    fireEvent.change(screen.getByTestId('video-cut-1'), { target: { value: '1.5' } });
    const handle = screen.getByTestId('video-cut-handle-0');
    fireEvent.pointerDown(handle, { button: 0, clientX: 160, pointerId: 1 });
    fireEvent.pointerMove(screen.getByTestId('video-cut-handle-0'), { clientX: 200, pointerId: 1 });
    expect(screen.getByTestId('video-cut-handle-0').style.left).toBe('49.6%');
    fireEvent.pointerUp(screen.getByTestId('video-cut-handle-0'), { clientX: 200, pointerId: 1 });
    expect(changes.at(-1)).toEqual([62, 75]);
  });

  it('keeps the focus and the typed text on the typed row when the bin of another row is pressed', () => {
    const changes: number[][] = [];
    render(<StatefulSplit cuts={[50, 75, 100]} changes={changes} />);
    act(() => (screen.getByTestId('video-cut-1') as HTMLInputElement).focus());
    fireEvent.change(screen.getByTestId('video-cut-1'), { target: { value: '3.3' } });
    const bin = screen.getAllByRole('button', { name: 'Remove' })[0]!;
    expect(fireEvent.mouseDown(bin)).toBe(false);
    fireEvent.click(bin);
    const focused = document.activeElement as HTMLInputElement;
    expect(focused).toBe(screen.getByTestId('video-cut-0'));
    expect(focused).toHaveValue('3.3');
    expect(screen.getByTestId('video-cut-1')).toHaveValue('4');
    // 3.3 s lies inside frame 82 and 3.35 s inside frame 83.
    expect(changes.at(-1)).toEqual([82, 100]);
    fireEvent.change(focused, { target: { value: '3.35' } });
    expect(changes.at(-1)).toEqual([83, 100]);
    expect(screen.getByTestId('video-cut-1')).toHaveValue('4');
  });

  it('keeps both rows and the focus while a row is typed equal to another, and merges them on blur', () => {
    render(<StatefulSplit cuts={[75, 100]} />);
    act(() => (screen.getByTestId('video-cut-1') as HTMLInputElement).focus());
    fireEvent.change(screen.getByTestId('video-cut-1'), { target: { value: '3' } });
    expect(screen.getByTestId('video-cut-0')).toHaveValue('3');
    expect(screen.getByTestId('video-cut-1')).toHaveValue('3');
    expect(screen.getByTestId('video-cut-1')).toHaveFocus();
    act(() => (screen.getByTestId('video-cut-1') as HTMLInputElement).blur());
    expect(screen.getByTestId('video-cut-0')).toHaveValue('3');
    expect(screen.queryByTestId('video-cut-1')).toBeNull();
  });

  it('orders the rows when Enter is pressed', () => {
    render(<StatefulSplit cuts={[75, 100]} />);
    act(() => (screen.getByTestId('video-cut-1') as HTMLInputElement).focus());
    fireEvent.change(screen.getByTestId('video-cut-1'), { target: { value: '1.5' } });
    fireEvent.keyDown(screen.getByTestId('video-cut-1'), { key: 'Enter' });
    // Frame 37, which 1.5 s lies in, starts at 1.48 s (§10.7).
    expect(screen.getByTestId('video-cut-0')).toHaveValue('1.48');
    expect(screen.getByTestId('video-cut-1')).toHaveValue('3');
  });
  it('removes the row whose bin is pressed while that row is typed', () => {
    const changes: number[][] = [];
    render(<StatefulSplit cuts={[75, 100]} changes={changes} />);
    act(() => (screen.getByTestId('video-cut-1') as HTMLInputElement).focus());
    fireEvent.change(screen.getByTestId('video-cut-1'), { target: { value: '1.5' } });
    const bin = screen.getAllByRole('button', { name: 'Remove' })[1]!;
    // The press keeps the focus in the typed row, so the rows are not reordered under the pointer before the click.
    expect(fireEvent.mouseDown(bin)).toBe(false);
    fireEvent.click(bin);
    expect(changes.at(-1)).toEqual([75]);
  });
});

describe('Add at cursor decides a new cut by the frame it would split at', () => {
  it('is available exactly where planVideoSplit gains a segment', () => {
    const cuts = [25, 75, 62];
    const { rerender } = mount({ draft: draftWith(cuts) });
    for (const time of [0, 0.01, 0.04, 0.99, 1, 1.03, 1.04, 2.47, 2.48, 2.5, 2.52, 3.02, 4.96, 4.99, 5]) {
      rerender({ presentedTime: time });
      // The frame a presented time shows is round(mediaTime × fps) (frames-split §4.3).
      const expected = time > 0 && time < 5 && planVideoSplit(grid, [...cuts, frameIndexOfMediaTime(time, grid)]).length > planVideoSplit(grid, cuts).length;
      expect(screen.getByTestId('video-add-cut').hasAttribute('disabled'), String(time)).toBe(!expected);
    }
  });
});

describe('stepping a handle', () => {
  it('keeps the focus on a handle stepped or dragged, so the next key moves it again', () => {
    const changes: number[][] = [];
    render(<StatefulSplit cuts={[25, 75]} changes={changes} />);
    layOutTrack();
    act(() => screen.getByTestId('video-cut-handle-0').focus());
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-0'), { key: 'ArrowRight' });
    expect(screen.getByTestId('video-cut-handle-0')).toHaveFocus();
    fireEvent.pointerDown(screen.getByTestId('video-cut-handle-1'), { button: 0, clientX: 220, pointerId: 1 });
    fireEvent.pointerMove(screen.getByTestId('video-cut-handle-1'), { clientX: 260, pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('video-cut-handle-1'), { clientX: 260, pointerId: 1 });
    expect(changes.at(-1)![1]).toBe(100);
    expect(screen.getByTestId('video-cut-handle-1')).toHaveFocus();
  });
});

describe('a step keeps a cut off the first frame, as a drag and Add at cursor do', () => {
  it('does not step back onto the first frame', () => {
    const { onChange } = mount({ draft: draftWith([1]) });
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-0'), { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Add at cursor while the source plays', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /**
   * Runs the pending animation frames once.
   */
  function tick(): void {
    const pending = [...frames.values()];
    frames.clear();
    act(() => { for (const callback of pending) callback(0); });
  }

  /**
   * A playing source element.
   * @returns The element.
   */
  function playingElement(): HTMLVideoElement {
    const element = document.createElement('video');
    Object.defineProperty(element, 'paused', { configurable: true, get: () => false });
    return element;
  }

  it('stores the live time at the press, not the stale panel time', () => {
    const changes: number[][] = [];
    render(<StatefulSplit cuts={[25, 75]} presentedTime={0.4} liveClock={{ element: playingElement(), read: () => 3.2 }} changes={changes} />);
    tick();
    fireEvent.click(screen.getByTestId('video-add-cut'));
    // 3.2 s is the start of frame 80.
    expect(changes.at(-1)).toEqual([25, 75, 80]);
  });

  it('makes no whole split plan on the animation frames of a playing source', () => {
    let now = 0.5;
    render(<StatefulSplit cuts={[25, 75]} presentedTime={0.4} liveClock={{ element: playingElement(), read: () => now }} />);
    tick();
    vi.mocked(planVideoSplit).mockClear();
    for (let frame = 0; frame < 5; frame += 1) { now += 0.37; tick(); }
    expect(planVideoSplit).not.toHaveBeenCalled();
  });

  it('becomes available once the shown time moves past 0', () => {
    let now = 0;
    render(<StatefulSplit cuts={[]} presentedTime={0} liveClock={{ element: playingElement(), read: () => now }} />);
    tick();
    expect(screen.getByTestId('video-add-cut')).toBeDisabled();
    now = 0.5;
    tick();
    expect(screen.getByTestId('video-add-cut')).toBeEnabled();
  });
});

describe('cut rows show their frame start in milliseconds (frames-split §10.7 split row; web AGENTS "Inputs send what they show")', () => {
  const grid30 = { fps: { numerator: 30, denominator: 1 }, frameCount: 593 };

  it('shows a 30 fps frame start rounded up to the millisecond, never a long fraction', () => {
    mount({ grid: grid30, draft: draftWith([10, 269]) });
    expect(screen.getByTestId('video-cut-0')).toHaveValue('0.334');
    expect(screen.getByTestId('video-cut-1')).toHaveValue('8.967');
  });

  it('keeps every shown time on the frame it stands for, so typing it back changes nothing', () => {
    fc.assert(fc.property(fc.constantFrom(24, 25, 30, 50, 60, 120), fc.integer({ min: 1, max: 590 }), (fps, frame) => {
      cleanup();
      const { onChange } = mount({ grid: { fps: { numerator: fps, denominator: 1 }, frameCount: 593 }, draft: draftWith([frame]) });
      const shown = (screen.getByTestId('video-cut-0') as HTMLInputElement).value;
      expect(shown).toMatch(/^\d+(\.\d{1,3})?$/);
      fireEvent.change(screen.getByTestId('video-cut-0'), { target: { value: shown } });
      for (const call of onChange.mock.calls) expect(call[0]).toEqual(expect.objectContaining({ params: { cuts: [frame] } }));
    }), { numRuns: 60 });
  });
});
