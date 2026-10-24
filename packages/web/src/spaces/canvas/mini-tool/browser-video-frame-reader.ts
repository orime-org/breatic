// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ALL_FORMATS, Input, UnsupportedInputFormatError, UrlSource, VideoSampleSink } from 'mediabunny';
import { httpRequest } from '@breatic/shared';

export type BrowserVideoReadErrorCode = 'network' | 'invalid-media' | 'decode-failed' | 'no-video' | 'empty-video';

/** A failed raw media read, distinct from decoder capability and cancellation. */
export class BrowserVideoReadError extends Error {
  readonly code: BrowserVideoReadErrorCode;

  /**
   * Preserve the original failure without inferring capability from its text.
   * @param code - The failed reading phase.
   * @param cause - The original network, metadata or decoder error.
   * @throws {never} Never.
   */
  constructor(code: BrowserVideoReadErrorCode, cause?: unknown) {
    super(`Video frame read failed: ${code}`, { cause });
    this.name = 'BrowserVideoReadError';
    this.code = code;
  }
}

/** A plain copy of one sample; it carries no live decoder resources. */
export interface BrowserVideoFrame {
  frameIndex: number;
  timestampSeconds: number;
  durationSeconds: number;
  displayWidth: number;
  displayHeight: number;
}

/** Independent library readings; none declares the final presentation window. */
export interface BrowserVideoDurationReadings {
  videoTrackComputedEndSeconds: number;
  inputComputedEndSeconds: number;
  inputMetadataEndSeconds: number | null;
}

export interface BrowserVideoFrameReadRequest { url: string; sourceKey: string; signal: AbortSignal }
export type BrowserVideoFrameReadResult =
  | {
    status: 'ready';
    sourceKey: string;
    frames: BrowserVideoFrame[];
    timeResolution: number;
    displayWidth: number;
    displayHeight: number;
    durationReadings: BrowserVideoDurationReadings;
  }
  | { status: 'unsupported'; sourceKey: string; reason: 'unsupported-format' | 'video-decoder-unavailable' };

/**
 * Reads every raw decoded sample without choosing a presentation window.
 * @param request - The frozen source identity and its cancellation lifetime.
 * @returns Independent frame facts or an explicit unsupported capability.
 * @throws {BrowserVideoReadError} When networking, metadata or decoding fails.
 * @throws {DOMException} When the caller cancels the read.
 */
export async function readBrowserVideoFrameTable(request: BrowserVideoFrameReadRequest): Promise<BrowserVideoFrameReadResult> {
  let input: Input | undefined;
  let phase: 'invalid-media' | 'decode-failed' = 'invalid-media';

  /**
   * Stop library I/O as soon as this particular source read is cancelled.
   * @throws {never} Never.
   */
  const onAbort = (): void => { input?.dispose(); };

  /**
   * Keep cancellation distinct from a disposal or HTTP error caused by it.
   * @throws {DOMException} When this source read has been cancelled.
   */
  const checkAbort = (): void => {
    if (request.signal.aborted) throw new DOMException('Video frame reading was cancelled', 'AbortError');
  };

  try {
    checkAbort();
    input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(request.url, {
        // Shared HTTP owns delivery retries; the library must not add a second budget.
        getRetryDelay: () => null,
        fetchFn: async (address, init = {}): Promise<Response> => {
          try {
            const url = address instanceof Request ? address.url : String(address);
            const response = await httpRequest(url, init, { replaySafe: true, signal: init.signal ?? undefined });
            if (!response.ok) throw new BrowserVideoReadError('network', new Error(`Media request returned HTTP ${response.status}`));
            return response;
          } catch (cause) {
            if (cause instanceof BrowserVideoReadError) throw cause;
            throw new BrowserVideoReadError('network', cause);
          }
        },
      }),
    });
    request.signal.addEventListener('abort', onAbort, { once: true });
    checkAbort();
    const track = await input.getPrimaryVideoTrack();
    checkAbort();
    if (track === null) throw new BrowserVideoReadError('no-video');
    const canDecode = await track.canDecode();
    checkAbort();
    if (!canDecode) return { status: 'unsupported', sourceKey: request.sourceKey, reason: 'video-decoder-unavailable' };
    const [videoTrackComputedEndSeconds, inputComputedEndSeconds, inputMetadataEndSeconds, timeResolution, displayWidth, displayHeight] = await Promise.all([
      track.computeDuration(), input.computeDuration(), input.getDurationFromMetadata(),
      track.getTimeResolution(), track.getDisplayWidth(), track.getDisplayHeight(),
    ]);
    checkAbort();
    phase = 'decode-failed';
    const frames: BrowserVideoFrame[] = [];
    for await (const sample of new VideoSampleSink(track).samples(-Infinity, Infinity)) {
      try {
        // A pending decoder may deliver its last owned sample after disposal.
        checkAbort();
        frames.push({
          frameIndex: frames.length, timestampSeconds: sample.timestamp, durationSeconds: sample.duration,
          displayWidth: sample.displayWidth, displayHeight: sample.displayHeight,
        });
      } finally {
        sample.close();
      }
    }
    checkAbort();
    if (frames.length === 0) throw new BrowserVideoReadError('empty-video');
    return {
      status: 'ready', sourceKey: request.sourceKey, frames, timeResolution, displayWidth, displayHeight,
      durationReadings: { videoTrackComputedEndSeconds, inputComputedEndSeconds, inputMetadataEndSeconds },
    };
  } catch (cause) {
    checkAbort();
    if (cause instanceof UnsupportedInputFormatError) return { status: 'unsupported', sourceKey: request.sourceKey, reason: 'unsupported-format' };
    if (cause instanceof BrowserVideoReadError) throw cause;
    throw new BrowserVideoReadError(phase, cause);
  } finally {
    request.signal.removeEventListener('abort', onAbort);
    input?.dispose();
  }
}
