// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
const draft: VideoToolDraftById['video.extract-frames'] = { version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [], params: { mode: 'first', currentTime: 0.13, interval: 0.04 } };
const table = { frames: [{ frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0.04 }, { frameIndex: 2, pts: 0.12 }, { frameIndex: 3, pts: 0.2 }], videoEnd: 0.28 };
const common = { toolId: 'video.extract-frames' as const, draft, analyses: [], frameTable: table, disabled: false, pickingSlot: null, inputNames: new Map(), onPick: vi.fn(), onAnalyse: vi.fn(), analysing: false, onEditTimeline: vi.fn() };

describe('explicit unknown presented frame', () => {
  it('disables only Current when no actual frame exists and keeps the real-table modes reachable', () => {
    // The baseline numeric signature is intentionally exercised with the upcoming nullable contract.
    render(<VideoToolControls {...common} presentedTime={null as unknown as number} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-frame-mode-current')).toBeDisabled();
    for (const mode of ['first', 'last', 'interval']) expect(screen.getByTestId(`video-frame-mode-${mode}`)).not.toBeDisabled();
  });

  it('never persists a fabricated zero or null Current time while selecting a table-only mode', () => {
    const onChange = vi.fn();
    render(<VideoToolControls {...common} presentedTime={null as unknown as number} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('video-frame-mode-last'));
    expect(onChange).toHaveBeenCalledWith({ ...draft, params: { ...draft.params, mode: 'last' } });
  });

  it('accepts an actual presented time of zero rather than treating it as unknown', () => {
    render(<VideoToolControls {...common} presentedTime={0} onChange={vi.fn()} />);
    expect(screen.getByTestId('video-frame-mode-current')).not.toBeDisabled();
  });
});
