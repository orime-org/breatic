// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Readable } from "node:stream";

/** One complete owned BGR24 frame at its exact decoded sequence index. */
export interface AnalysisRawFrame { frameIndex: number; bytes: Buffer }
/** The frozen dimensions, selected frame count and lifetime of an owned pipe. */
export interface AnalysisFrameReadRequest {
  source: Readable;
  width: number;
  height: number;
  expectedFrameCount: number;
  signal: AbortSignal;
}

/**
 * Preserve cancellation when closing a pipe also produces a stream error.
 * @param signal - The lifetime of this one source read.
 * @throws {DOMException} When this read has been cancelled.
 */
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Analysis frame reading was cancelled", "AbortError");
}

/**
 * Read complete BGR frames without resampling or inventing source timestamps.
 * @param request - The owned binary pipe and its frozen frame geometry.
 * @returns Owned complete frames in decoded order.
 * @throws {RangeError} When frozen geometry or frame count is invalid.
 * @throws {DOMException} When this read is cancelled.
 * @throws {Error} When the pipe fails, has nonbinary data or differs from its frame ledger.
 */
export async function* readAnalysisFrames(request: AnalysisFrameReadRequest): AsyncGenerator<AnalysisRawFrame, void> {
  const { source, signal, width, height, expectedFrameCount } = request;
  /**
   * Close only this read's pipe so its pending iterator wakes immediately.
   * @throws {never} Never.
   */
  const onAbort = (): void => { source.destroy(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    assertActive(signal);
    const frameBytes = width * height * 3;
    if (![width, height, frameBytes, expectedFrameCount].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError("Analysis requires positive integral geometry and a complete frame ledger");
    }
    let frame: Buffer | null = null;
    let filled = 0;
    let frameIndex = 0;
    // This owner closes the pipe in finally. The default iterator destroys it
    // with AbortError on an early return, masking a ledger failure upstream.
    for await (const chunk of source.iterator({ destroyOnReturn: false })) {
      assertActive(signal);
      if (!(chunk instanceof Uint8Array)) throw new TypeError("Analysis pipe must contain binary BGR bytes");
      let offset = 0;
      while (offset < chunk.length) {
        if (frameIndex >= expectedFrameCount) throw new Error("Analysis pipe contains more frames than its ledger");
        frame ??= Buffer.allocUnsafe(frameBytes);
        const length = Math.min(frameBytes - filled, chunk.length - offset);
        frame.set(chunk.subarray(offset, offset + length), filled);
        filled += length;
        offset += length;
        if (filled === frameBytes) {
          const complete = { frameIndex, bytes: frame };
          frameIndex += 1;
          frame = null;
          filled = 0;
          yield complete;
          assertActive(signal);
        }
      }
    }
    assertActive(signal);
    if (filled !== 0 || frameIndex !== expectedFrameCount) throw new Error("Analysis pipe ended before its complete frame ledger");
  } catch (error) {
    assertActive(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    source.destroy();
  }
}
