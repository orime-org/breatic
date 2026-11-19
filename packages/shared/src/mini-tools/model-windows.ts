// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** A presentation interval in seconds. */
export interface PresentationSpan { start: number; end: number }

/** One model window: its presentation span and the request duration the model is asked for. */
export interface ModelWindow { span: PresentationSpan; duration: 5 | 10 }

const EPSILON = 1e-9;

/**
 * Cuts presented frames into model windows in presentation time (execution design §10.5): each window spans at most
 * `maxSeconds`, overlaps the previous one by at least `overlapSeconds` and starts after it; a window's start is the last
 * frame boundary inside that overlap, or a time inside a long frame when the overlap holds none. A window asks for 10 s, or
 * 5 s when it is the last and spans at most 5 s (the two measured request lengths).
 * @param frames - The presented frames in order, [start, end) seconds.
 * @param maxSeconds - The longest span of a window.
 * @param overlapSeconds - The shortest overlap of two windows.
 * @returns The windows in order.
 * @throws {RangeError} When there are no frames.
 */
export function planModelWindows(frames: readonly PresentationSpan[], maxSeconds = 10, overlapSeconds = 0.625): ModelWindow[] {
  if (frames.length === 0) throw new RangeError("A model window needs at least one frame");
  const end = frames.at(-1)!.end;
  const windows: ModelWindow[] = [];
  let start = frames[0]!.start;
  for (;;) {
    const stop = Math.min(start + maxSeconds, end);
    const last = stop >= end - EPSILON;
    windows.push({ span: { start, end: last ? end : stop }, duration: last && stop - start <= 5 + EPSILON ? 5 : 10 });
    if (last) return windows;
    const latest = stop - overlapSeconds;
    const boundary = frames.findLast((frame) => frame.start > start + EPSILON && frame.start <= latest + EPSILON)?.start;
    start = boundary ?? latest;
  }
}
