// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { ALL_FORMATS, CanvasSink, Input, UrlSource } from 'mediabunny';
import { httpRequest } from '@breatic/shared';

export interface VideoThumbnail { frameIndex: number; pts: number; url: string }
export interface VideoThumbnailState { status: 'loading' | 'ready' | 'failed'; frames: readonly VideoThumbnail[] }
type SourceFrame = { frameIndex: number; pts: number };

/**
 * Decodes exact selected presentation timestamps using an independently owned reader.
 * @param url - The registered canonical source address.
 * @param frames - The complete selected source-frame identities.
 * @param signal - This attachment's cancellation lifetime.
 * @returns Real PNG thumbnails preserving the selected source identities.
 * @throws {Error} When decoding, pixel access or authoritative frame matching fails.
 */
async function readThumbnails(url: string, frames: readonly SourceFrame[], signal: AbortSignal): Promise<VideoThumbnail[]> {
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, {
    getRetryDelay: () => null,
    fetchFn: async (address, init = {}): Promise<Response> => httpRequest(address instanceof Request ? address.url : String(address), init, { replaySafe: true, signal: signal.aborted ? signal : init.signal ?? signal }),
  }) });
  let disposed = false;
  /**
   * Releases the same decoder exactly once on completion or cancellation.
   * @throws {never} Never.
   */
  function dispose(): void { if (disposed) return; disposed = true; input.dispose(); }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    if (signal.aborted) throw new DOMException('Thumbnail reading cancelled', 'AbortError');
    const track = await input.getPrimaryVideoTrack();
    if (track === null || !await track.canDecode()) throw new Error('Source video cannot be decoded for thumbnails');
    const sink = new CanvasSink(track, { width: 480, alpha: true });
    const result: VideoThumbnail[] = [];
    for await (const decoded of sink.canvasesAtTimestamps(frames.map((frame) => frame.pts))) {
      if (signal.aborted) throw new DOMException('Thumbnail reading cancelled', 'AbortError');
      const requested = frames[result.length];
      if (decoded === null || requested === undefined || Math.abs(decoded.timestamp - requested.pts) > Math.max(1, Math.abs(requested.pts)) * Number.EPSILON * 16) throw new Error('Decoded thumbnail does not match the authoritative source frame');
      let canvas: HTMLCanvasElement;
      if (decoded.canvas instanceof HTMLCanvasElement) canvas = decoded.canvas;
      else {
        canvas = document.createElement('canvas'); canvas.width = decoded.canvas.width; canvas.height = decoded.canvas.height;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('Thumbnail canvas unavailable');
        context.drawImage(decoded.canvas, 0, 0);
      }
      result.push({ ...requested, url: canvas.toDataURL('image/png') });
    }
    if (result.length !== frames.length) throw new Error('Thumbnail decoding ended before every selected frame');
    return result;
  } finally {
    signal.removeEventListener('abort', dispose);
    dispose();
  }
}

/**
 * Decodes selected authoritative source frames during this attachment lifetime.
 * @param url - Registered canonical source address.
 * @param frames - The selected source frames in presentation order.
 * @param retry - The current retry value.
 * @returns The current decoder state and real frame images.
 * @throws {never} Decode failures are returned as a visible state.
 */
export function useVideoFrameThumbnails(url: string, frames: readonly SourceFrame[], retry = 0): VideoThumbnailState {
  const frameKey = JSON.stringify(frames.map(({ frameIndex, pts }) => ({ frameIndex, pts })));
  const key = JSON.stringify([url, frameKey, retry]);
  const [state, setState] = React.useState<VideoThumbnailState & { key: string }>({ key: '', status: 'loading', frames: [] });
  React.useEffect(() => {
    const controller = new AbortController();
    const selected = JSON.parse(frameKey) as SourceFrame[];
    setState({ key, status: selected.length === 0 ? 'ready' : 'loading', frames: [] });
    if (selected.length === 0) return () => controller.abort();
    void readThumbnails(url, selected, controller.signal).then((images) => { if (!controller.signal.aborted) setState({ key, status: 'ready', frames: images }); }, () => { if (!controller.signal.aborted) setState({ key, status: 'failed', frames: [] }); });
    return () => controller.abort();
  }, [url, frameKey, key]);
  return state.key === key ? state : { status: 'loading', frames: [] };
}
