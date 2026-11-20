// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { createVideoRenderer } from '@web/spaces/canvas/video-presentation/create-video-renderer';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import { frameIndexOfMediaTime, frameMidpointSeconds } from '@web/spaces/canvas/video-presentation/frame-grid-time';

export interface VideoThumbnail { frameIndex: number; url: string }
export interface VideoThumbnailState { status: 'loading' | 'ready' | 'failed'; frames: readonly VideoThumbnail[] }

/**
 * Capture selected grid frames using the same native/alpha renderer as playback (frames-split §4.3): each card seeks its
 * frame's midpoint (i + 0.5) / fps and captures on the frame callback that presents that frame, never on `seeked` alone.
 * @param source - The panel's current playback source.
 * @param frames - Selected grid frame numbers, in requested order.
 * @param signal - This attachment's cancellation lifetime.
 * @returns PNG captures of the actual composited surfaces.
 * @throws {Error} When rendering, pixel access or cancellation fails.
 */
async function readThumbnails(source: VideoPresentationSource, frames: readonly number[], signal: AbortSignal): Promise<VideoThumbnail[]> {
  const host = document.createElement('div');
  let video: HTMLVideoElement | null = null;
  let surface: HTMLVideoElement | HTMLCanvasElement | null = null;
  let seekEpoch = 0;
  let target: number | null = null;
  const grid = source.presentation.display;
  let capture: (() => void) | null = null;
  let rejectReady!: (error: unknown) => void;
  let resolveReady!: () => void;
  let rejectCapture: ((error: unknown) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  /**
   * Reject all current waits; cleanup releases the renderer in the same lifetime.
   * @param error - The renderer failure or caller's cancellation reason.
   * @throws {never} Never.
   */
  function fail(error: unknown): void { rejectReady(error); rejectCapture?.(error); }
  /**
   * Cancel readiness or a seek immediately when this attachment ends.
   * @throws {never} Never.
   */
  function abort(): void { fail(signal.reason); }
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  const renderer = createVideoRenderer(host, source, {
    ready: (element, rendered) => {
      if (video === null) { video = element; surface = rendered; video.muted = true; resolveReady(); }
    },
    frame: (time, epoch) => { if (epoch === seekEpoch && !video?.seeking && target !== null && frameIndexOfMediaTime(time, grid) === target) capture?.(); },
    getSeekEpoch: () => seekEpoch,
    error: (code) => fail(new Error(code)),
    contextLost: () => fail(new Error('Thumbnail renderer lost its context')),
    contextRestored: () => undefined,
  });
  try {
    await ready;
    signal.throwIfAborted();
    const element = video! as HTMLVideoElement;
    const image = surface! as HTMLVideoElement | HTMLCanvasElement;
    const canvas = document.createElement('canvas');
    canvas.width = source.presentation.display.width;
    canvas.height = source.presentation.display.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Thumbnail canvas unavailable');
    const result: VideoThumbnail[] = [];
    for (const selected of frames) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        rejectCapture = reject;
        capture = (): void => {
          if (signal.aborted || element.seeking) return;
          try {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            result.push({ frameIndex: selected, url: canvas.toDataURL('image/png') });
            capture = null; rejectCapture = null; resolve();
          } catch (error) { reject(error); }
        };
        target = selected;
        seekEpoch += 1;
        element.currentTime = frameMidpointSeconds(selected, grid.fps);
      });
    }
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
    renderer.dispose();
  }
}

/**
 * Capture selected frames while owning and releasing the playback renderer in one effect.
 * @param source - Current validated presentation, or none while waiting for it.
 * @param frames - The selected grid frame numbers.
 * @param retry - Explicit preview retry revision.
 * @returns Current captures, immediately empty when source or selection changes.
 * @throws {never} Rendering failures are returned as a visible state.
 */
export function useVideoFrameThumbnails(source: VideoPresentationSource | null, frames: readonly number[], retry = 0): VideoThumbnailState {
  const sourceKey = JSON.stringify(source);
  const frameKey = JSON.stringify(frames);
  const key = JSON.stringify([sourceKey, frameKey, retry]);
  const [state, setState] = React.useState<VideoThumbnailState & { key: string }>({ key: '', status: 'loading', frames: [] });
  React.useEffect(() => {
    const controller = new AbortController();
    const selected = JSON.parse(frameKey) as number[];
    const playback = JSON.parse(sourceKey) as VideoPresentationSource | null;
    setState({ key, status: selected.length === 0 ? 'ready' : 'loading', frames: [] });
    if (selected.length === 0 || playback === null) return () => controller.abort();
    void readThumbnails(playback, selected, controller.signal).then((images) => { if (!controller.signal.aborted) setState({ key, status: 'ready', frames: images }); }, () => { if (!controller.signal.aborted) setState({ key, status: 'failed', frames: [] }); });
    return () => controller.abort();
  }, [sourceKey, frameKey, key]);
  return state.key === key ? state : { status: 'loading', frames: [] };
}
