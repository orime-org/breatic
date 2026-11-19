// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 canvas design §4 transitions row and invariant 11.2: the transitions panel has one video input slot. The
 * current video is always the other clip and is never a slot; clearing the slot leaves the draft with the current video only.
 */

import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { t } from '@breatic/shared';
import { describe, expect, it, vi } from 'vitest';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';
import { createVideoToolDraft, transitionHostInputId } from '../video/video-tool-edit';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const picked = { inputId: '60000000-0000-4000-8000-000000000001', url: 'https://media.example.test/picked.mp4', cover: 'https://media.example.test/picked.jpg', mediaInfo: { duration: 3 }, sourceNodeId: '10000000-0000-4000-8000-000000000002' };

/**
 * Renders the transitions controls for one draft.
 * @param draft - The transitions draft.
 * @param onChange - Receives every edited draft.
 * @returns Nothing.
 * @throws {never} Never.
 */
function renderSlot(draft: VideoToolDraftById['video.transitions'], onChange: (next: unknown) => void = vi.fn()): void {
  render(<VideoToolControls toolId='video.transitions' draft={draft} analyses={[]} frameTable={null} presentedTime={0} disabled={false} pickingSlot={null}
    inputNames={new Map()} onPick={vi.fn()} onAnalyse={vi.fn()} analysing={false} onEditTimeline={vi.fn()} onChange={onChange} />);
}

/**
 * The current video's draft with one picked input after it.
 * @returns The two-clip draft.
 * @throws {never} Never.
 */
function withPicked(): VideoToolDraftById['video.transitions'] {
  const draft = createVideoToolDraft('video.transitions', source);
  return { ...draft, inputs: [...draft.inputs, picked], params: { clips: [...draft.params.clips, { clipId: '50000000-0000-4000-8000-000000000002', inputId: picked.inputId, in: 0, out: 3, transition: { kind: 'cut', duration: 0 } }] } };
}

describe('the transitions input slot', () => {
  it('shows one empty slot and no clear button while only the current video is in the draft', () => {
    renderSlot(createVideoToolDraft('video.transitions', source));
    expect(screen.getAllByTestId('video-timeline-input')).toHaveLength(1);
    expect(screen.queryByTestId('video-timeline-thumbnail')).toBeNull();
    expect(screen.queryByTestId('video-timeline-clear')).toBeNull();
  });

  it('shows the picked video in the one slot', () => {
    renderSlot(withPicked());
    expect(screen.getAllByTestId('video-timeline-input')).toHaveLength(1);
    expect(screen.getByTestId('video-timeline-thumbnail').getAttribute('src')).toBe(picked.cover);
  });

  it('clearing the slot keeps the current video and its clip', () => {
    const draft = withPicked();
    const onChange = vi.fn();
    renderSlot(draft, onChange);
    fireEvent.click(screen.getByTestId('video-timeline-clear'));
    const next = onChange.mock.calls[0]?.[0] as VideoToolDraftById['video.transitions'];
    expect(next.inputs).toEqual([draft.inputs[0]]);
    expect(next.params.clips).toEqual([draft.params.clips[0]]);
  });
});

describe('the transitions panel as the approved demo lays it out', () => {
  it('draws the slot with the film icon and says what it is for in both states', () => {
    renderSlot(createVideoToolDraft('video.transitions', source));
    expect(screen.getByTestId('video-timeline-input').querySelector('.lucide-film')).not.toBeNull();
    expect(screen.getByText(t('canvas.miniTool.videoUI.timelineSlotHint'))).toBeInTheDocument();
  });

  it('summarises each clip on the timeline in order with its length', () => {
    const draft = withPicked();
    render(<VideoToolControls toolId='video.transitions' draft={{ ...draft, params: { clips: [draft.params.clips[0]!, { ...draft.params.clips[1]!, in: 0.5, out: 2.75 }] } }} analyses={[]} frameTable={null} presentedTime={0}
      disabled={false} pickingSlot={null} inputNames={new Map([[draft.inputs[0]!.inputId, 'Current'], [picked.inputId, 'Picked']])} onPick={vi.fn()} onAnalyse={vi.fn()} analysing={false} onEditTimeline={vi.fn()} onChange={vi.fn()} />);
    const rows = screen.getAllByTestId('video-timeline-clip-summary');
    expect(rows.map((row) => row.textContent)).toEqual(['1 · Current5.00 s', '2 · Picked2.25 s']);
  });

  it('shows the current video alone in the summary while the slot is empty', () => {
    renderSlot(createVideoToolDraft('video.transitions', source));
    expect(screen.getAllByTestId('video-timeline-clip-summary')).toHaveLength(1);
  });

  it('offers Edit timeline only once a video is in the slot', () => {
    renderSlot(createVideoToolDraft('video.transitions', source));
    expect(screen.queryByRole('button', { name: t('canvas.miniTool.videoUI.editTimeline') })).toBeNull();
    const onEdit = vi.fn();
    render(<VideoToolControls toolId='video.transitions' draft={withPicked()} analyses={[]} frameTable={null} presentedTime={0} disabled={false} pickingSlot={null}
      inputNames={new Map()} onPick={vi.fn()} onAnalyse={vi.fn()} analysing={false} onEditTimeline={onEdit} onChange={vi.fn()} />);
    fireEvent.click(within(document.body).getByRole('button', { name: t('canvas.miniTool.videoUI.editTimeline') }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});

describe('transitionHostInputId', () => {
  it('names the current video\'s input wherever it sits', () => {
    const draft = withPicked();
    expect(transitionHostInputId({ ...draft, inputs: [...draft.inputs].reverse() })).toBe(draft.inputs[0]!.inputId);
  });

  it('names nothing for a draft without the current video', () => {
    expect(transitionHostInputId({ ...withPicked(), inputs: [picked] })).toBeUndefined();
  });
});
