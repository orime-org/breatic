// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 (canvas design §4 转场行, invariant 11.2; tools design §58; demo 2026-10-23-1306-video-tools
 * `timeline-editor.tsx`): the transitions Dialog holds exactly two clips, the node's current video (its input's
 * `sourceNodeId` is the host) and the one picked input. A single "Swap order" button (`canvas.miniTool.videoUI.swapClips`,
 * the demo's `swapClips`) swaps them and the transition stays between them, carried by whichever clip is first (demo
 * `swap()`). There is one transition, edited the same whichever clip is selected (demo `editJunction`). The multi-clip
 * editor's asset rail, add, earlier/later, duplicate and remove controls are gone (design: 不增、不删、不复制).
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { VideoPresentationTable, VideoToolDraftById, VideoToolTimelineClip } from '@breatic/shared/mini-tools';

const track: { props: Record<string, unknown> | null } = { props: null };

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@breatic/shared/mini-tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  transitionDurationBounds: vi.fn(),
}));
// The track editor and the GL preview are not drawn by jsdom; the track only records what it is handed.
vi.mock('@xzdarcy/react-timeline-editor', async () => ({
  Timeline: (await import('react')).forwardRef((props: Record<string, unknown>, _ref) => { track.props = props; return null; }),
}));
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({ VideoTimelinePreview: () => null }));

import * as miniTools from '@breatic/shared/mini-tools';
import { VideoTimelineDialog } from '../video/VideoTimelineDialog';

type Bounds = { min: number; max: number } | null;
type Draft = VideoToolDraftById['video.transitions'];
const bounds = vi.mocked((miniTools as unknown as { transitionDurationBounds: (clips: readonly VideoToolTimelineClip[], fps: { numerator: string; denominator: string }) => Bounds }).transitionDurationBounds);

const HOST = '10000000-0000-4000-8000-000000000001';
const PICKED_NODE = '10000000-0000-4000-8000-000000000002';
const source = { nodeId: HOST, canonicalURL: 'https://media.example.test/a.mp4', mediaInfo: { width: 960, height: 540, duration: 6, mimeType: 'video/mp4' } };
const current = { inputId: '60000000-0000-4000-8000-000000000001', url: source.canonicalURL, mediaInfo: source.mediaInfo, sourceNodeId: HOST };
const picked = { inputId: '60000000-0000-4000-8000-000000000002', url: 'https://media.example.test/b.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' }, sourceNodeId: PICKED_NODE };
const TABLE: VideoPresentationTable = { schemaVersion: 1, timescale: 30, runs: [{ start: 0, count: 180, step: 1, duration: 1 }] };
const inputTables = new Map([[current.inputId, TABLE], [picked.inputId, TABLE]]);
const hostClip: VideoToolTimelineClip = { clipId: '50000000-0000-4000-8000-000000000001', inputId: current.inputId, in: 1, out: 5, transition: { kind: 'fade', duration: 0.5 } };
const pickedClip: VideoToolTimelineClip = { clipId: '50000000-0000-4000-8000-000000000002', inputId: picked.inputId, in: 0.5, out: 3, transition: { kind: 'cut', duration: 0 } };
const draft: Draft = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [current, picked],
  params: { clips: [hostClip, pickedClip] },
};

/**
 * Mounts the open Dialog on the two-clip draft.
 * @param onChange - Receives every committed edit.
 * @returns Nothing.
 */
function open(onChange: (next: Draft) => void): void {
  const proposed: object = { inputTables };
  render(<VideoTimelineDialog open onOpenChange={vi.fn()} draft={draft} onChange={onChange} inputNames={new Map([[current.inputId, 'Current'], [picked.inputId, 'Picked']])} disabled={false} onRun={vi.fn()} {...proposed} />);
}

/**
 * The selected-clip control: its trigger reads "1. <name>".
 * @returns The trigger.
 */
function clipSelector(): HTMLElement {
  const trigger = screen.getAllByRole('combobox').find((box) => /^\d+\./.test(box.textContent ?? ''));
  if (trigger === undefined) throw new Error('No selected-clip control');
  return trigger;
}

/**
 * Every transition type control: each combobox that is not the selected-clip control.
 * @returns The triggers.
 */
function transitionTypes(): HTMLElement[] {
  return screen.getAllByRole('combobox').filter((box) => !/^\d+\./.test(box.textContent ?? ''));
}

/**
 * The draft handed to the last `onChange` call.
 * @param onChange - The spy.
 * @returns That draft.
 */
function lastDraft(onChange: ReturnType<typeof vi.fn>): Draft {
  expect(onChange).toHaveBeenCalled();
  return onChange.mock.calls.at(-1)![0] as Draft;
}

beforeEach(() => { vi.clearAllMocks(); track.props = null; bounds.mockReturnValue({ min: 0.2, max: 1.2 }); });

describe('the transitions Dialog holds the current video and the picked input (canvas design §4 转场, invariant 11.2)', () => {
  it('puts exactly the two draft clips on the track and in the clip selector, current video first', async () => {
    const user = userEvent.setup();
    open(vi.fn());
    const rows = track.props?.editorData as { actions: { id: string }[] }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].actions.map((action) => action.id)).toEqual([hostClip.clipId, pickedClip.clipId]);
    await user.click(clipSelector());
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['1. Current', '2. Picked']);
  });
});

describe('only the swap control changes the order (canvas design invariant 11.2)', () => {
  it('makes no clip draggable and hands the track no move callbacks, so a drag can neither reorder nor commit', () => {
    open(vi.fn());
    const rows = track.props?.editorData as { actions: { movable?: boolean; flexible?: boolean }[] }[];
    expect(rows[0].actions.map((action) => [action.movable, action.flexible])).toEqual([[false, true], [false, true]]);
    expect(track.props?.onActionMoveStart).toBeUndefined();
    expect(track.props?.onActionMoveEnd).toBeUndefined();
  });

  it('still trims a clip from its resize handles', () => {
    const onChange = vi.fn();
    open(onChange);
    const props = track.props as { onActionResizeStart: () => void; onActionResizeEnd: (value: { action: { id: string }; start: number; end: number }) => void };
    act(() => { props.onActionResizeStart(); });
    act(() => { props.onActionResizeEnd({ action: { id: hostClip.clipId }, start: 0.5, end: 4 }); });
    expect(lastDraft(onChange).params.clips).toEqual([{ ...hostClip, in: 1.5 }, pickedClip]);
  });
});

describe('one Swap order control reverses the two clips (tools design §58; demo swap())', () => {
  it('commits the picked clip first, each keeping its in/out, with the transition still between them', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    open(onChange);
    expect(screen.getAllByRole('button', { name: t('canvas.miniTool.videoUI.swapClips') })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.swapClips') }));
    expect(lastDraft(onChange).params.clips).toEqual([
      { ...pickedClip, transition: hostClip.transition },
      { ...hostClip, transition: { kind: 'cut', duration: 0 } },
    ]);
  });
});

describe('there is exactly one transition between the two clips (canvas design §4 中间转场; demo editJunction)', () => {
  it('shows the same single type and duration with the second clip selected and edits the first clip\'s transition', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    open(onChange);
    await user.click(clipSelector());
    await user.click(await screen.findByRole('option', { name: '2. Picked' }));
    expect(clipSelector()).toHaveTextContent('2. Picked');
    const types = transitionTypes();
    expect(types).toHaveLength(1);
    expect(types[0]).toHaveTextContent(t('canvas.miniTool.videoUI.transitionFade'));
    expect(types[0]).toBeEnabled();
    expect(screen.getAllByTestId('video-clip-overlap')).toHaveLength(1);
    fireEvent.change(screen.getByTestId('video-clip-overlap'), { target: { value: '0.8' } });
    const clips = lastDraft(onChange).params.clips;
    expect(clips.map((clip) => clip.clipId)).toEqual([hostClip.clipId, pickedClip.clipId]);
    expect(clips[0].transition).toEqual({ kind: 'fade', duration: 0.8 });
    expect(clips[1].transition).toEqual({ kind: 'cut', duration: 0 });
  });
});

describe('the multi-clip controls are gone (design: 不增、不删、不复制; 4.4.5 feature removed)', () => {
  it.each(['timelineAssets', 'addToTimeline', 'earlier', 'later', 'duplicateClip', 'removeClip'])('renders no %s', (key) => {
    open(vi.fn());
    expect(screen.queryAllByText(t(`canvas.miniTool.videoUI.${key}`))).toHaveLength(0);
  });
});

describe('the instructions sit in the header and the footer says what Export makes (demo timeline-editor.tsx footer)', () => {
  it('shows the instructions once and the export hint in the footer while every field is valid', () => {
    open(vi.fn());
    expect(screen.getAllByText(t('canvas.miniTool.videoUI.timelineInstructions'))).toHaveLength(1);
    expect(screen.getByText(t('canvas.miniTool.videoUI.timelineExportHint'))).toBeInTheDocument();
    expect(screen.queryByText(t('canvas.miniTool.videoUI.invalidNumber'))).toBeNull();
  });

  it('shows the invalid-number error in place of the hint while a field is invalid', () => {
    open(vi.fn());
    expect(screen.getByText(t('canvas.miniTool.videoUI.timelineExportHint'))).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('video-clip-out'), { target: { value: 'x' } });
    expect(screen.getByText(t('canvas.miniTool.videoUI.invalidNumber'))).toBeInTheDocument();
    expect(screen.queryByText(t('canvas.miniTool.videoUI.timelineExportHint'))).toBeNull();
  });
});
