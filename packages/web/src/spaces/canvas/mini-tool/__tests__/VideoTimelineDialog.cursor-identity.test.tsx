// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306: preview playback moves the cursor every frame. The track editor re-syncs its state whenever `editorData`
 * changes reference, so a fresh array on every cursor change nests updates until React gives up and the preview reads
 * "Preview unavailable". The track data keeps its reference while only the cursor moves, is rebuilt after a draft edit
 * and after a cancelled gesture (a fresh mount must not reuse actions the editor mutated mid-drag), and every cursor move
 * reaches the track's own clock.
 */

import * as React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPresentationTable, VideoToolDraftById, VideoToolTimelineClip } from '@breatic/shared/mini-tools';

// Each Timeline mount takes the next number, and its setTime reports (mount, time): the library has no initial-time prop.
const track: { props: Record<string, unknown> | null; mounts: number; setTime: ReturnType<typeof vi.fn> } = { props: null, mounts: 0, setTime: vi.fn() };
const preview: { onCursorChange: ((time: number) => void) | null } = { onCursorChange: null };

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
// jsdom draws neither the track editor nor the GL preview; each records what it is handed.
vi.mock('@xzdarcy/react-timeline-editor', async () => {
  const react = await import('react');
  return {
    Timeline: react.forwardRef((props: Record<string, unknown>, ref) => {
      const [mount] = react.useState(() => ++track.mounts);
      react.useImperativeHandle(ref, () => ({ setTime: (time: number) => track.setTime(mount, time) }), [mount]);
      track.props = props;
      return null;
    }),
  };
});
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({
  VideoTimelinePreview: (props: { onCursorChange: (time: number) => void }) => { preview.onCursorChange = props.onCursorChange; return null; },
}));

import { VideoTimelineDialog } from '../video/VideoTimelineDialog';

type Draft = VideoToolDraftById['video.transitions'];
const HOST = '10000000-0000-4000-8000-000000000001';
const source = { nodeId: HOST, canonicalURL: 'https://media.example.test/a.mp4', mediaInfo: { width: 960, height: 540, duration: 6, mimeType: 'video/mp4' } };
const current = { inputId: '60000000-0000-4000-8000-000000000001', url: source.canonicalURL, mediaInfo: source.mediaInfo, sourceNodeId: HOST };
const picked = { inputId: '60000000-0000-4000-8000-000000000002', url: 'https://media.example.test/b.mp4', mediaInfo: { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' } };
const TABLE: VideoPresentationTable = { schemaVersion: 1, timescale: 30, runs: [{ start: 0, count: 180, step: 1, duration: 1 }] };
const inputTables = new Map([[current.inputId, TABLE], [picked.inputId, TABLE]]);
const inputNames = new Map([[current.inputId, 'Current'], [picked.inputId, 'Picked']]);
const hostClip: VideoToolTimelineClip = { clipId: '50000000-0000-4000-8000-000000000001', inputId: current.inputId, in: 1, out: 5, transition: { kind: 'cut', duration: 0 } };
const pickedClip: VideoToolTimelineClip = { clipId: '50000000-0000-4000-8000-000000000002', inputId: picked.inputId, in: 0.5, out: 3, transition: { kind: 'cut', duration: 0 } };
const draft: Draft = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [current, picked],
  params: { clips: [hostClip, pickedClip] },
};
const onOpenChange = vi.fn();
const onChange = vi.fn();
const onRun = vi.fn();

/**
 * The Dialog on a draft, with every other prop held stable across rerenders.
 * @param edited - The draft to show.
 * @returns The element.
 */
function dialog(edited: Draft): React.JSX.Element {
  const proposed: object = { inputTables };
  return <VideoTimelineDialog open onOpenChange={onOpenChange} draft={edited} onChange={onChange} inputNames={inputNames} disabled={false} onRun={onRun} {...proposed} />;
}

/**
 * The track data last handed to the editor.
 * @returns That data.
 */
function editorData(): unknown {
  return track.props?.editorData;
}

beforeEach(() => { vi.clearAllMocks(); track.props = null; track.mounts = 0; preview.onCursorChange = null; });

describe('the track data keeps its reference while only the cursor moves', () => {
  it('hands the editor the same data across preview cursor moves, and each time reaches the track clock', () => {
    render(dialog(draft));
    const first = editorData();
    expect(first).toBeDefined();
    for (const time of [0.1, 0.2, 0.3]) act(() => { preview.onCursorChange!(time); });
    expect(editorData()).toBe(first);
    expect(track.setTime.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([0.1, 0.2, 0.3]));
  });

  it('hands the editor new data after a draft edit', () => {
    const { rerender } = render(dialog(draft));
    const first = editorData();
    rerender(dialog({ ...draft, params: { clips: [{ ...hostClip, in: 1.5 }, pickedClip] } }));
    expect(editorData()).not.toBe(first);
  });

  it('hands the editor new data after a cancelled gesture', () => {
    render(dialog(draft));
    const first = editorData();
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(editorData()).not.toBe(first);
  });
});

describe('a remounted track starts at the cursor', () => {
  it('moves the playhead of the mount a cancelled drag brings to the cursor', () => {
    render(dialog(draft));
    act(() => { preview.onCursorChange!(3); });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(track.mounts).toBe(2);
    expect(track.setTime).toHaveBeenLastCalledWith(2, 3);
  });

  it('moves the playhead of the mount an edit brings to the new end when the edit shortens the composition below the cursor', () => {
    const { rerender } = render(dialog(draft));
    act(() => { preview.onCursorChange!(6); });
    rerender(dialog({ ...draft, revision: '30000000-0000-4000-8000-000000000002', params: { clips: [{ ...hostClip, out: 2 }, pickedClip] } }));
    expect(track.mounts).toBe(2);
    expect(track.setTime).toHaveBeenLastCalledWith(2, 3.5);
  });
});
