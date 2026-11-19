// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type * as Thumbnails from '../video/use-video-frame-thumbnails';
import { VideoToolControls } from '../video/VideoToolControls';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';

// §97 G1 (canvas design §4 抽帧行, line 100; demo 2026-10-23-1306-video-tools): below the one row of mode buttons the frames
// panel shows ONE preview of the actually selected frame, filling the row width, with its image and its time.
vi.mock('@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<typeof Thumbnails>()),
  useVideoFrameThumbnails: (): Thumbnails.VideoThumbnailState => ({ status: 'ready', frames: [{ frameIndex: 2, pts: 0.12, url: 'blob:selected-frame' }] }),
}));
const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: 'https://media.example.test/source.webm', mediaInfo: { width: 160, height: 240, duration: 0.28, mimeType: 'video/webm' } };
const draft = { version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [],
  params: { mode: 'current', currentTime: 0.13 } } as unknown as VideoToolDraftById['video.extract-frames'];
const table = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 1, step: 4, duration: 4 }, { start: 4, count: 3, step: 8, duration: 8 }] };

describe('the single frame preview (§97 G1; canvas design §4)', () => {
  it('shows exactly one full-row preview of the selected frame with its image and time', () => {
    render(<VideoToolControls toolId='video.extract-frames' draft={draft} analyses={[]} frameTable={table} disabled={false} pickingSlot={null} inputNames={new Map()}
      onPick={vi.fn()} onAnalyse={vi.fn()} analysing={false} onEditTimeline={vi.fn()} presentedTime={0.13} onChange={vi.fn()} />);
    const previews = screen.getByTestId('video-frame-previews');
    const images = previews.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('blob:selected-frame');
    expect(previews.textContent).toContain('0.120');
    // Full row width: no ancestor between the image and the preview root is a half-width card.
    const chain: Element[] = [];
    for (let node = images[0].parentElement; node !== null && node !== previews; node = node.parentElement) chain.push(node);
    expect(chain.some((node) => node.className.includes('50%'))).toBe(false);
    expect(chain.some((node) => node.classList.contains('w-full'))).toBe(true);
  });
});
