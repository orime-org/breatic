// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 extract frames panel layout (canvas design §4 extract-frames row: three buttons in one row; demo main.tsx frames branch
 * grid-cols-3 and its ledger lines; frames-split §10.6 panel hookup: while the grid is not usable only its line shows).
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
const draft = { version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [], params: { mode: 'first', frameIndex: 0 } } as unknown as VideoToolDraftById['video.extract-frames'];
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 7 };
const common = { toolId: 'video.extract-frames' as const, draft, analyses: [], disabled: false, onAnalyse: vi.fn(), analysing: false, onChange: vi.fn(), presentedTime: 0.1 };

describe('extract frames layout (canvas design §4 frames row)', () => {
  it('puts the three modes as equal thirds of one row with no heading above them', () => {
    render(<VideoToolControls {...common} grid={grid} />);
    const row = screen.getByTestId('video-frame-mode-first').parentElement!;
    expect(row.className).toContain('grid-cols-3');
    expect([...row.children].map((child) => child.getAttribute('data-testid'))).toEqual(['video-frame-mode-first', 'video-frame-mode-last', 'video-frame-mode-current']);
    expect(screen.queryByText('Frame selection')).toBeNull();
  });

  it('shows neither the frame preview nor a frame-count line while the grid is not usable', () => {
    const { container } = render(<VideoToolControls {...common} grid={null} />);
    expect(screen.queryByTestId('video-frame-previews')).toBeNull();
    expect(screen.queryByText('Reading video frames…')).toBeNull();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('puts the frame preview directly under the modes with no frame-count line', () => {
    const { container } = render(<VideoToolControls {...common} grid={grid} />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect(screen.getByTestId('video-frame-mode-first').parentElement!.nextElementSibling).toBe(screen.getByTestId('video-frame-previews'));
  });

  it('says the current frame is unavailable above the preview while Current has no shown frame', () => {
    const current = { ...draft, params: { mode: 'current', frameIndex: 0 } } as unknown as VideoToolDraftById['video.extract-frames'];
    render(<VideoToolControls {...common} draft={current} presentedTime={null} grid={grid} />);
    expect(screen.getByText('Current frame unavailable').nextElementSibling).toBe(screen.getByTestId('video-frame-previews'));
  });

  it('keeps the modes usable while the grid is not usable', () => {
    render(<VideoToolControls {...common} grid={null} />);
    for (const mode of ['first', 'last', 'current']) expect(screen.getByTestId(`video-frame-mode-${mode}`)).not.toBeDisabled();
  });
});
