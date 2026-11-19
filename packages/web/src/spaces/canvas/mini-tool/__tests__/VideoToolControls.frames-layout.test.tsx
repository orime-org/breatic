// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 extract frames panel layout (canvas design §4 extract-frames row: three buttons in one row; demo main.tsx frames branch
 * grid-cols-3 and its ledger lines; frames-split §10.6 panel hookup: while the frame table is not usable only its line shows).
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { VideoToolControls } from '../video/VideoToolControls';

vi.mock('@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../video/use-video-frame-thumbnails')>()),
  useVideoFrameThumbnails: () => ({ status: 'loading', frames: [] }),
}));
const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.webm', mediaInfo: { width: 160, height: 240, duration: 0.28, mimeType: 'video/webm' } };
const draft = { version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [], params: { mode: 'first', currentTime: 0 } } as unknown as VideoToolDraftById['video.extract-frames'];
const table = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 1, step: 4, duration: 4 }, { start: 4, count: 3, step: 8, duration: 8 }] };
const common = { toolId: 'video.extract-frames' as const, draft, analyses: [], disabled: false, pickingSlot: null, inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn(), onChange: vi.fn(), presentedTime: 0.1 };

describe('extract frames layout (canvas design §4 frames row)', () => {
  it('puts the three modes as equal thirds of one row with no heading above them', () => {
    render(<VideoToolControls {...common} frameTable={table} />);
    const row = screen.getByTestId('video-frame-mode-first').parentElement!;
    expect(row.className).toContain('grid-cols-3');
    expect([...row.children].map((child) => child.getAttribute('data-testid'))).toEqual(['video-frame-mode-first', 'video-frame-mode-last', 'video-frame-mode-current']);
    expect(screen.queryByText('Frame selection')).toBeNull();
  });

  it('shows neither the frame preview nor a frame-count line while the frame table is not usable', () => {
    const { container } = render(<VideoToolControls {...common} frameTable={null} />);
    expect(screen.queryByTestId('video-frame-previews')).toBeNull();
    expect(screen.queryByText('Reading video frames…')).toBeNull();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('puts the frame preview directly under the modes with no frame-count line', () => {
    const { container } = render(<VideoToolControls {...common} frameTable={table} />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect(screen.getByTestId('video-frame-mode-first').parentElement!.nextElementSibling).toBe(screen.getByTestId('video-frame-previews'));
  });

  it('says the current frame is unavailable above the preview while Current has no shown frame', () => {
    const current = { ...draft, params: { mode: 'current', currentTime: 0 } } as unknown as VideoToolDraftById['video.extract-frames'];
    render(<VideoToolControls {...common} draft={current} presentedTime={null} frameTable={table} />);
    expect(screen.getByText('Current frame unavailable').nextElementSibling).toBe(screen.getByTestId('video-frame-previews'));
  });

  it('keeps the modes usable while the frame table is not usable', () => {
    render(<VideoToolControls {...common} frameTable={null} />);
    for (const mode of ['first', 'last', 'current']) expect(screen.getByTestId(`video-frame-mode-${mode}`)).not.toBeDisabled();
  });
});
