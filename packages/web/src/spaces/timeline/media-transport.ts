// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineRate } from '@breatic/shared';

/** The native state and current preview request observed together. */
export interface TimelineMediaTransportInput {
  intent: 'play' | 'pause';
  generationMatches: boolean;
  targetReady: boolean;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  error: boolean;
  readyState: number;
}

/** The current preview state derived from native media facts. */
export type TimelineMediaTransport = 'failed' | 'paused' | 'waiting' | 'playing';

/**
 * Resolve the current media state for a Timeline preview.
 * @param input - The current request and native element facts.
 * @returns The preview transport state.
 * @throws {never} Never.
 */
export function resolveTimelineMediaTransport(input: TimelineMediaTransportInput): TimelineMediaTransport {
  if (input.error) return 'failed';
  if (input.intent === 'pause') return 'paused';
  if (!input.generationMatches || !input.targetReady || input.paused
    || input.seeking || input.ended || input.readyState < 3) return 'waiting';
  return 'playing';
}

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
