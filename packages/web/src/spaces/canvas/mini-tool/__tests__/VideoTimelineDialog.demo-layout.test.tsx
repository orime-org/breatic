// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 (demo 2026-10-23-1306-video-tools `timeline-editor.tsx`; canvas design §4 transitions row and §10 editor × export):
 * the transitions Dialog reads as the approved demo does. The composition row states the first clip's frame size, frame
 * rate and the length; the transport has a rewind button; the properties aside labels the clip selector and heads the
 * transition section; each track block shows its source's frames, name and source in → out; the ruler reads seconds;
 * a first non-Cut transition starts at 0.4 s within its bounds; Export is the primary button; an invalid number leaves
 * Export aria-disabled with a toast that says so.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';
import type { VideoPlanGrid, VideoToolDraftById, VideoToolTimelineClip } from '@breatic/shared/mini-tools';

const track: { props: Record<string, unknown> | null } = { props: null };
const strips: { props: Record<string, unknown>[] } = { props: [] };
const preview: { props: Record<string, unknown> | null } = { props: null };

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@breatic/shared/mini-tools', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  transitionDurationBounds: vi.fn(),
}));
// jsdom draws neither the track editor nor the GL preview nor video frames; each only records what it is handed.
vi.mock('@xzdarcy/react-timeline-editor', async () => ({
  Timeline: (await import('react')).forwardRef((props: Record<string, unknown>, _ref) => { track.props = props; return null; }),
}));
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({ VideoTimelinePreview: (props: Record<string, unknown>) => { preview.props = props; return null; } }));
vi.mock('@web/spaces/canvas/mini-tool/FilmStrip', () => ({ FilmStrip: (props: Record<string, unknown>) => { strips.props.push(props); return <div data-testid='strip' />; } }));

import * as miniTools from '@breatic/shared/mini-tools';
import { toast } from '@web/lib/toast';
import { VideoTimelineDialog } from '../video/VideoTimelineDialog';

type Draft = VideoToolDraftById['video.transitions'];
const bounds = vi.mocked((miniTools as unknown as { transitionDurationBounds: () => { min: number; max: number } | null }).transitionDurationBounds);

const HOST = '10000000-0000-4000-8000-000000000001';
const source = { nodeId: HOST, canonicalURL: 'https://media.example.test/a.mp4', mediaInfo: { width: 1280, height: 720, duration: 6, mimeType: 'video/mp4' } };
const current = { inputId: '60000000-0000-4000-8000-000000000001', url: source.canonicalURL, mediaInfo: source.mediaInfo, sourceNodeId: HOST };
const picked = { inputId: '60000000-0000-4000-8000-000000000002', url: 'https://media.example.test/b.mp4', mediaInfo: { width: 720, height: 1280, duration: 5, mimeType: 'video/mp4' } };
// The first clip runs at 30000/1001 fps, the second at 25 fps: only the first one's rate may be shown.
const NTSC: VideoPlanGrid = { fps: { numerator: 30000, denominator: 1001 }, frameCount: 180 };
const PAL: VideoPlanGrid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const inputGrids = new Map([[current.inputId, NTSC], [picked.inputId, PAL]]);
const hostClip: VideoToolTimelineClip = { clipId: '50000000-0000-4000-8000-000000000001', inputId: current.inputId, in: 1, out: 5, transition: { kind: 'cut', duration: 0 } };
const pickedClip: VideoToolTimelineClip = { clipId: '50000000-0000-4000-8000-000000000002', inputId: picked.inputId, in: 0.5, out: 3, transition: { kind: 'cut', duration: 0 } };
const draft: Draft = {
  version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [current, picked],
  params: { clips: [hostClip, pickedClip] },
};
type Formats = ReadonlyMap<string, { width: number; height: number; transparent: boolean }>;
const opaque: Formats = new Map([[current.inputId, { width: 1920, height: 1080, transparent: false }], [picked.inputId, { width: 1080, height: 1920, transparent: false }]]);

/**
 * Mounts the open Dialog.
 * @param options - What differs from the two-clip default.
 * @param options.onChange - Receives every committed edit.
 * @param options.inputFormats - Each input's selected display size and transparency.
 * @param options.onRun - The export entry.
 * @param options.edited - The draft to open, the two-clip default when omitted.
 * @returns Nothing.
 */
function open({ onChange = vi.fn(), inputFormats = opaque, onRun = vi.fn(), edited = draft }: { onChange?: (next: Draft) => void; inputFormats?: Formats; onRun?: () => Promise<unknown> | undefined; edited?: Draft } = {}): void {
  const proposed: object = { inputGrids, inputFormats };
  render(<VideoTimelineDialog open onOpenChange={vi.fn()} draft={edited} onChange={onChange} inputNames={new Map([[current.inputId, 'Current'], [picked.inputId, 'Picked']])} disabled={false} onRun={onRun} {...proposed} />);
}

beforeEach(() => { vi.clearAllMocks(); track.props = null; preview.props = null; strips.props = []; bounds.mockReturnValue({ min: 0.2, max: 1.2 }); });

describe('A1 the composition row states the first clip format (demo timeline-editor.tsx:45; canvas design §4 transitions row)', () => {
  it('reads "{width} × {height} · {fps} fps · {duration}" from the first clip\'s display size and grid rate', () => {
    open();
    expect(screen.getByText('1920 × 1080 · 29.97 fps · 6.500 s')).toBeInTheDocument();
  });

  it('falls back to the first input\'s registered size while its presentation is unknown', () => {
    open({ inputFormats: new Map() });
    expect(screen.getByText('1280 × 720 · 29.97 fps · 6.500 s')).toBeInTheDocument();
  });
});

describe('A2 the preview gets the first clip\'s frame and the output transparency (canvas design §4 transitions row)', () => {
  it('hands the preview the first clip size, opaque when neither input is transparent', () => {
    open();
    expect(preview.props?.format).toEqual({ width: 1920, height: 1080, transparent: false });
  });

  it('is transparent when either input is transparent', () => {
    open({ inputFormats: new Map([[current.inputId, { width: 1920, height: 1080, transparent: false }], [picked.inputId, { width: 1080, height: 1920, transparent: true }]]) });
    expect(preview.props?.format).toEqual({ width: 1920, height: 1080, transparent: true });
  });
});

describe('A3 a rewind button sits left of Preview and seeks to the start (demo transport row)', () => {
  it('moves the cursor back to 0', () => {
    open();
    const props = track.props as { onClickTimeArea: (time: number) => boolean };
    act(() => { props.onClickTimeArea(2); });
    expect(screen.getByText('2.000 / 6.500 s')).toBeInTheDocument();
    const rewind = screen.getByRole('button', { name: t('canvas.miniTool.videoUI.rewind') });
    const previewButton = screen.getByRole('button', { name: t('canvas.miniTool.videoUI.preview') });
    expect(rewind.compareDocumentPosition(previewButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(rewind);
    expect(screen.getByText('0.000 / 6.500 s')).toBeInTheDocument();
  });
});

describe('A4 and A5 the properties aside labels the clip selector and heads the transition (demo aside sections)', () => {
  it('labels the clip selector "Selected clip"', () => {
    open();
    const label = screen.getByText(t('canvas.miniTool.videoUI.selectedClip'));
    expect(within(label.closest('label')!).getByRole('combobox')).toHaveTextContent('1. Current');
  });

  it('heads the transition type with "Transition between"', () => {
    open();
    const heading = screen.getByRole('heading', { name: t('canvas.miniTool.videoUI.transitionBetween') });
    const type = screen.getByText(t('canvas.miniTool.videoUI.transition'));
    expect(heading.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('A6 each track block shows its source frames, its name and its source in → out (demo getActionRender)', () => {
  it('renders the clip name, the source range and a strip of that range of its source', () => {
    open();
    const render$ = track.props?.getActionRender as (action: { id: string; start: number; end: number }) => React.ReactNode;
    // The second clip sits at 4 s in the composition; the block states its source range, not that position.
    render(<>{render$({ id: pickedClip.clipId, start: 4, end: 6.5 })}</>);
    expect(screen.getByText('Picked')).toBeInTheDocument();
    expect(screen.getByText('0.50 s → 3.00 s')).toBeInTheDocument();
    expect(strips.props.at(-1)).toEqual({ src: picked.url, start: 0.5, duration: 2.5, aspect: 720 / 1280 });
  });

  it('draws the strip of a video picked from the Canvas, which brings only its length, at its display shape', () => {
    // A pick copies the node's length alone (VideoToolPanelContainer slot handling); its shape comes from its presentation.
    const lengthOnly = { ...picked, mediaInfo: { duration: 5 } };
    open({ edited: { ...draft, inputs: [current, lengthOnly] } });
    const render$ = track.props?.getActionRender as (action: { id: string; start: number; end: number }) => React.ReactNode;
    render(<>{render$({ id: pickedClip.clipId, start: 4, end: 6.5 })}</>);
    expect(strips.props.at(-1)).toEqual({ src: picked.url, start: 0.5, duration: 2.5, aspect: 1080 / 1920 });
  });
});

describe('A7 the ruler reads seconds (demo getScaleRender)', () => {
  it('labels each scale "Ns"', () => {
    open();
    const scale = track.props?.getScaleRender as (value: number) => React.ReactNode;
    render(<>{scale(2)}</>);
    expect(screen.getByText('2s')).toBeInTheDocument();
  });

  it('labels each second up to the one after the end and leaves the right-edge boundary unlabelled', () => {
    // The two clips run 4 s + 2.5 s = 6.5 s: eight scales (demo timeline-editor.tsx:30), labelled 0s to 7s. The editor also
    // draws a label on the boundary after the last scale, which is its right edge and would cut that label in half.
    open();
    expect(track.props?.minScaleCount).toBe(8);
    expect(track.props?.maxScaleCount).toBe(8);
    expect((track.props?.style as { width: number }).width).toBe(900);
    const scale = track.props?.getScaleRender as (value: number) => React.ReactNode;
    const { container } = render(<>{[0, 7, 8].map((value) => <div key={value} data-value={value}>{scale(value)}</div>)}</>);
    expect(container.querySelector('[data-value="0"]')).toHaveTextContent('0s');
    expect(container.querySelector('[data-value="7"]')).toHaveTextContent('7s');
    expect(container.querySelector('[data-value="8"]')).toBeEmptyDOMElement();
  });
});

describe('A8 a first non-Cut transition starts at 0.4 s within its bounds (demo timeline-editor.tsx:48)', () => {
  it.each([
    ['wide bounds', { min: 0.2, max: 1.2 }, 0.4],
    ['an upper bound under 0.4 s', { min: 0.1, max: 0.3 }, 0.3],
  ])('switching Cut to Crossfade with %s', async (_name, range, expected) => {
    bounds.mockReturnValue(range);
    const user = userEvent.setup();
    const onChange = vi.fn();
    open({ onChange });
    const type = screen.getAllByRole('combobox').find((box) => !/^\d+\./.test(box.textContent ?? ''))!;
    await user.click(type);
    await user.click(await screen.findByRole('option', { name: t('canvas.miniTool.videoUI.transitionFade') }));
    expect((onChange.mock.calls.at(-1)![0] as Draft).params.clips[0].transition).toEqual({ kind: 'fade', duration: expected });
  });
});

describe('A9 Export is the primary button with the Film icon (demo footer)', () => {
  it('uses the default variant', () => {
    open();
    const exportButton = screen.getByRole('button', { name: t('canvas.miniTool.videoUI.export') });
    expect(exportButton.className).toContain('bg-primary');
    expect(exportButton.querySelector('.lucide-film')).not.toBeNull();
  });
});

describe('A11 an invalid number leaves Export aria-disabled and a press says why (canvas design §10; web AGENTS disabled controls)', () => {
  it('is aria-disabled, not disabled, and a press warns with the invalid-number reason without exporting', () => {
    const onRun = vi.fn();
    open({ onRun });
    fireEvent.change(screen.getByTestId('video-clip-out'), { target: { value: 'x' } });
    const exportButton = screen.getByRole('button', { name: t('canvas.miniTool.videoUI.export') });
    expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    expect(exportButton).not.toBeDisabled();
    fireEvent.click(exportButton);
    expect(toast.warning).toHaveBeenCalledWith(t('canvas.miniTool.videoUI.invalidNumber'));
    expect(onRun).not.toHaveBeenCalled();
  });
});
