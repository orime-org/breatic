// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { TimelineRate } from '@breatic/shared';

/** The preview transport: paused, waiting for every layer to be in place, or playing. */
export type TimelineMediaTransport = 'paused' | 'waiting' | 'playing';

/**
 * Project monotonic elapsed time onto the Timeline's integer frame clock.
 * @param anchor - The last confirmed frame and monotonic timestamp.
 * @param anchor.frame - The last confirmed integer frame.
 * @param anchor.at - Its monotonic timestamp in milliseconds.
 * @param now - The current monotonic timestamp in milliseconds.
 * @param fps - The document's frame rate.
 * @param endFrame - The inclusive last frame.
 * @returns The current bounded integer frame.
 * @throws {never} Never.
 */
export function timelineFrameAt(anchor: { frame: number; at: number }, now: number, fps: TimelineRate, endFrame: number): number {
  const elapsed = Math.max(0, now - anchor.at);
  const advanced = Math.floor(elapsed * fps.num / (1000 * fps.den));
  return Math.max(0, Math.min(endFrame, anchor.frame + advanced));
}
