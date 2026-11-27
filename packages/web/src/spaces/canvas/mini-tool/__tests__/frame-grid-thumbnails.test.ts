// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 test plan §69 U02 (frames-split design §4.3, §10.6 "帧预览卡片"): a frame preview card names a grid frame
 * number; the panel's playback file is sought to that frame's midpoint (i + 0.5) / fps of the selected version's grid, and
 * the picture is captured on the requestVideoFrameCallback that presents that frame, never on `seeked` alone. The
 * renderer is replaced by a driver that behaves as Chromium does for a paused seek: `seeking`, `seeked`, then a frame
 * callback whose mediaTime is the presented frame's start.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import * as thumbnails from '../video/use-video-frame-thumbnails';

const FPS = { numerator: 30, denominator: 1 };
const driver = vi.hoisted(() => ({ seeks: [] as number[], deliverFrames: true, fps: 30 }));

import type * as RendererModule from '@web/spaces/canvas/video-presentation/create-video-renderer';
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  createVideoRenderer: vi.fn((host: HTMLElement, _source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    const element = document.createElement('video');
    let time = 0;
    let seeking = false;
    Object.defineProperties(element, {
      seeking: { get: () => seeking },
      requestVideoFrameCallback: { value: vi.fn(() => 1) },
      cancelVideoFrameCallback: { value: vi.fn() },
      currentTime: { get: () => time, set: (value: number) => {
        driver.seeks.push(value); time = value; seeking = true; element.dispatchEvent(new Event('seeking'));
        queueMicrotask(() => {
          seeking = false; element.dispatchEvent(new Event('seeked'));
          // The presented frame's timestamp is its start on the grid.
          if (driver.deliverFrames) callbacks.frame(Math.floor(value * driver.fps) / driver.fps, callbacks.getSeekEpoch());
        });
      } },
    });
    host.append(element);
    queueMicrotask(() => callbacks.ready(element, element));
    return { dispose: () => element.remove() };
  }),
}));

type Hook = (source: VideoPresentationSource, frames: readonly number[], retry?: number) => thumbnails.VideoThumbnailState;
const useThumbnails = thumbnails.useVideoFrameThumbnails as unknown as Hook;
const playback = 'https://assets.example.test/playback.mp4';
const source = { canonicalURL: 'https://assets.example.test/source.mov', sourceFingerprint: 'a'.repeat(64), manifest: null,
  presentation: { versionId: 'e'.repeat(64), toolInputId: 'd'.repeat(64), display: { width: 96, height: 64, fps: FPS, frameCount: 90, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 90, leadFrames: 0, holdFrames: 0 },
    playback: { kind: 'native', carrier: { url: playback } } } } as unknown as VideoPresentationSource;

beforeEach(() => {
  driver.seeks = []; driver.deliverFrames = true;
  (vi.spyOn(HTMLCanvasElement.prototype, 'getContext') as unknown as MockInstance<(contextId: string) => unknown>).mockImplementation(() => ({ drawImage: vi.fn(), clearRect: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/png;base64,capture');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('U02 frame preview cards seek grid midpoints and capture on the frame callback', () => {
  it('U02: cards for grid frames 7 and 0 seek (i + 0.5) / fps in plan order and capture each presented frame', async () => {
    const { result } = renderHook(() => useThumbnails(source, [7, 0]));
    await waitFor(() => expect(driver.seeks).toEqual([7.5 / 30, 0.5 / 30]));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.frames.map((frame) => frame.frameIndex)).toEqual([7, 0]);
  });

  it('U02: without a frame callback for the sought frame, seeked alone captures nothing', async () => {
    driver.deliverFrames = false;
    const { result } = renderHook(() => useThumbnails(source, [7]));
    await waitFor(() => expect(driver.seeks).toEqual([7.5 / 30]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.status).toBe('loading');
    expect(result.current.frames).toEqual([]);
  });
});
