// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VideoToolControls } from '../video/VideoToolControls';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';

vi.mock('@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../video/use-video-frame-thumbnails')>()),
  useVideoFrameThumbnails: () => ({ status: 'loading', frames: [] }),
}));
const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.webm', mediaInfo: { width: 160, height: 240, duration: 0.28, mimeType: 'video/webm' } };
const draft = { version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [], params: { mode: 'first', frameIndex: 3 } } as unknown as VideoToolDraftById['video.extract-frames'];
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 7 };
const common = { toolId: 'video.extract-frames' as const, draft, analyses: [], grid, disabled: false, pickingSlot: null, inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn() };

describe('explicit unknown presented frame', () => {
  it('disables only Current when no actual frame exists and keeps the grid modes reachable', () => {
    render(<VideoToolControls {...common} presentedTime={null} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-frame-mode-current')).toBeDisabled();
    for (const mode of ['first', 'last']) expect(screen.getByTestId(`video-frame-mode-${mode}`)).not.toBeDisabled();
  });

  // §97 (frames-split §10.6 删除行; canvas design §4 抽帧行; demo 2026-10-23-1306-video-tools): the frame modes are exactly
  // First, Last and Current, side by side in one row; the interval mode is gone.
  it('offers exactly the First, Last and Current modes in one row, with no interval mode', () => {
    render(<VideoToolControls {...common} presentedTime={0.13} onChange={vi.fn()} />);
    const modes = screen.getAllByTestId(/^video-frame-mode-/);
    expect(modes.map((mode) => mode.getAttribute('data-testid'))).toEqual(['video-frame-mode-first', 'video-frame-mode-last', 'video-frame-mode-current']);
    expect(new Set(modes.map((mode) => mode.parentElement)).size).toBe(1);
  });

  it('never persists a fabricated zero or null Current frame while selecting a grid-only mode', () => {
    const onChange = vi.fn();
    render(<VideoToolControls {...common} presentedTime={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('video-frame-mode-last'));
    expect(onChange).toHaveBeenCalledWith({ ...draft, params: { ...draft.params, mode: 'last' } });
  });

  it('accepts an actual presented time of zero rather than treating it as unknown', () => {
    render(<VideoToolControls {...common} presentedTime={0} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-frame-mode-current')).not.toBeDisabled();
  });
});
