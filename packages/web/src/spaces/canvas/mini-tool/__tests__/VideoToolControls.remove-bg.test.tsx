// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 remove background panel (canvas design §4 remove-background row (source preview); tools design §4 fixed transparent output and
 * kept audio; demo 2026-10-23-1306-video-tools main.tsx matte branch, video-controls.tsx PlaybackStrip).
 */

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';
import { VideoPlaybackStrip } from '../video/VideoPlaybackStrip';

const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.webm', mediaInfo: { width: 160, height: 90, duration: 5, mimeType: 'video/webm' } };
const draft = { version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [], params: {} } as unknown as VideoToolDraftById['video.remove-bg'];
const common = { toolId: 'video.remove-bg' as const, draft, analyses: [], grid: null, disabled: false, pickingSlot: null, inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(), onChange: vi.fn() };

/**
 * Gives the strip's track a fixed on-screen box, as the browser lays it out.
 * @param track - The track element.
 * @throws {never} Never.
 */
function layOut(track: HTMLElement): void {
  track.getBoundingClientRect = () => ({ left: 100, top: 0, width: 200, height: 48, right: 300, bottom: 48, x: 100, y: 0, toJSON: () => ({}) });
}

describe('remove background panel (canvas design §4 remove-background row)', () => {
  it('shows the source playback strip with its playhead and the start, current and end times', () => {
    render(<VideoToolControls {...common} presentedTime={1.25} onSeek={vi.fn()} />);
    const strip = screen.getByTestId('video-playback-strip');
    expect(strip.querySelector('[data-testid="mini-tool-filmstrip"]')).not.toBeNull();
    expect(screen.getByTestId('video-playback-head').style.left).toBe('25%');
    expect(screen.getByTestId('video-playback-times').textContent).toBe('0.00 s1.25 s5.00 s');
  });

  it('seeks the source to the clicked place on the strip', () => {
    const onSeek = vi.fn();
    render(<VideoToolControls {...common} presentedTime={0} onSeek={onSeek} />);
    const track = screen.getByTestId('video-playback-track');
    layOut(track);
    fireEvent.pointerDown(track, { button: 0, clientX: 150 });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(1.25);
  });

  it('shows the fixed Keep audio row with its check beside the transparent-output line', () => {
    render(<VideoToolControls {...common} presentedTime={0} />);
    const row = screen.getByText('Keep audio').parentElement!;
    expect(row.querySelector('svg.text-status-success')).not.toBeNull();
    expect(screen.getByText('Transparent source stays available for download and downstream tools.')).toBeInTheDocument();
  });

  it('offers Results ready only when a ready result can be opened, and opens it on press', () => {
    const { rerender } = render(<VideoToolControls {...common} presentedTime={0} />);
    expect(screen.queryByText('Results ready')).toBeNull();
    const onOpenResult = vi.fn();
    rerender(<VideoToolControls {...common} presentedTime={0} onOpenResult={onOpenResult} />);
    fireEvent.click(screen.getByRole('button', { name: /Results ready/ }));
    expect(onOpenResult).toHaveBeenCalledOnce();
  });

  it('spaces the trailing arrow of Results ready from its label', () => {
    render(<VideoToolControls {...common} presentedTime={0} onOpenResult={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Results ready/ }).className.split(' ')).toContain('gap-1.5');
  });
});

describe('the shared playback strip range (for erase)', () => {
  it('dims outside a given range and outlines inside it', () => {
    render(<VideoPlaybackStrip src={source.canonicalURL} duration={5} aspect={16 / 9} presentedTime={null} range={{ start: 1, end: 4 }} />);
    expect(screen.getByTestId('video-playback-range').style.left).toBe('20%');
    expect(screen.getByTestId('video-playback-range').style.width).toBe('60%');
    expect(screen.getByTestId('video-playback-before').style.width).toBe('20%');
    expect(screen.getByTestId('video-playback-after').style.width).toBe('20%');
    expect(screen.queryByTestId('video-playback-head')).toBeNull();
  });
});
