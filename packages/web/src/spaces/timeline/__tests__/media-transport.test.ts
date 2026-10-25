// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  resolveTimelineMediaTransport,
  timelineFrameAt,
} from '@web/spaces/timeline/media-transport';

type MediaSnapshot = Parameters<typeof resolveTimelineMediaTransport>[0];

const READY: MediaSnapshot = {
  intent: 'play',
  generationMatches: true,
  targetReady: true,
  paused: false,
  seeking: false,
  ended: false,
  error: false,
  readyState: 3,
};

describe('resolveTimelineMediaTransport', () => {
  it.each([3, 4])('confirms current playback at readyState %i', (readyState) => {
    expect(resolveTimelineMediaTransport({ ...READY, readyState })).toBe('playing');
  });

  it.each([0, 1, 2])('waits while an unpaused element has readyState %i', (readyState) => {
    expect(resolveTimelineMediaTransport({ ...READY, readyState })).toBe('waiting');
  });

  it('waits for a play request to start the paused element', () => {
    expect(resolveTimelineMediaTransport({ ...READY, paused: true })).toBe('waiting');
  });

  it('waits for the current source and frame generation', () => {
    expect(resolveTimelineMediaTransport({ ...READY, generationMatches: false })).toBe('waiting');
  });

  it('waits for the requested target to become ready', () => {
    expect(resolveTimelineMediaTransport({ ...READY, targetReady: false })).toBe('waiting');
  });

  it('waits while the current element is seeking', () => {
    expect(resolveTimelineMediaTransport({ ...READY, seeking: true })).toBe('waiting');
  });

  it('waits after the element has ended', () => {
    expect(resolveTimelineMediaTransport({ ...READY, ended: true })).toBe('waiting');
  });

  it('reports a current media error', () => {
    expect(resolveTimelineMediaTransport({ ...READY, error: true })).toBe('failed');
  });

  it('reports a media error when the user has paused an unready element', () => {
    expect(resolveTimelineMediaTransport({
      intent: 'pause', generationMatches: false, targetReady: false,
      paused: true, seeking: true, ended: true, error: true, readyState: 0,
    })).toBe('failed');
  });

  it.each([
    { paused: false },
    { paused: true },
    { seeking: true },
    { generationMatches: false },
    { targetReady: false },
    { ended: true },
    { readyState: 0 },
    { readyState: 1 },
    { readyState: 2 },
  ] satisfies Partial<MediaSnapshot>[])('retains pause intent with %j', (state) => {
    expect(resolveTimelineMediaTransport({ ...READY, ...state, intent: 'pause' })).toBe('paused');
  });

  it('confirms a buffered seek from current properties', () => {
    const seeking: MediaSnapshot = { ...READY, targetReady: false, seeking: true };
    expect(resolveTimelineMediaTransport(seeking)).toBe('waiting');
    expect(resolveTimelineMediaTransport({ ...seeking, targetReady: true, seeking: false })).toBe('playing');
  });

  it('confirms readiness when buffering recovers before seek completion', () => {
    const buffering: MediaSnapshot = { ...READY, readyState: 2, targetReady: false, seeking: true };
    expect(resolveTimelineMediaTransport(buffering)).toBe('waiting');
    expect(resolveTimelineMediaTransport({ ...buffering, readyState: 4 })).toBe('waiting');
    expect(resolveTimelineMediaTransport({ ...buffering, readyState: 4, targetReady: true, seeking: false })).toBe('playing');
  });

  it('keeps a pause issued during buffering through later media readiness', () => {
    const buffering: MediaSnapshot = { ...READY, readyState: 2 };
    expect(resolveTimelineMediaTransport(buffering)).toBe('waiting');
    expect(resolveTimelineMediaTransport({ ...buffering, intent: 'pause' })).toBe('paused');
    expect(resolveTimelineMediaTransport({ ...buffering, intent: 'pause', readyState: 4 })).toBe('paused');
  });

  it('holds the current generation while an earlier source becomes ready', () => {
    const previous: MediaSnapshot = { ...READY, generationMatches: false, targetReady: true, readyState: 4 };
    expect(resolveTimelineMediaTransport(previous)).toBe('waiting');
    expect(resolveTimelineMediaTransport({ ...previous, generationMatches: true, targetReady: false })).toBe('waiting');
    expect(resolveTimelineMediaTransport({ ...previous, generationMatches: true })).toBe('playing');
  });

  it('reads an immutable snapshot repeatedly', () => {
    const input = Object.freeze({ ...READY });
    expect(resolveTimelineMediaTransport(input)).toBe('playing');
    expect(resolveTimelineMediaTransport(input)).toBe('playing');
    expect(input).toEqual(READY);
  });
});

describe('timelineFrameAt', () => {
  it('starts at the anchor frame', () => {
    expect(timelineFrameAt({ frame: 72, at: 1000 }, 1000, { num: 24, den: 1 }, 239)).toBe(72);
  });

  it('holds the anchor frame when a clock observation precedes its anchor', () => {
    expect(timelineFrameAt({ frame: 72, at: 1000 }, 990, { num: 24, den: 1 }, 239)).toBe(72);
  });

  it('holds the current frame until the next sample boundary', () => {
    expect(timelineFrameAt({ frame: 72, at: 1000 }, 1041.66, { num: 24, den: 1 }, 239)).toBe(72);
    expect(timelineFrameAt({ frame: 72, at: 1000 }, 1041.67, { num: 24, den: 1 }, 239)).toBe(73);
  });

  it('advances by elapsed monotonic milliseconds', () => {
    expect(timelineFrameAt({ frame: 72, at: 1000 }, 1125, { num: 24, den: 1 }, 239)).toBe(75);
    expect(timelineFrameAt({ frame: 72, at: 1000 }, 2000, { num: 24, den: 1 }, 239)).toBe(96);
  });

  it('uses the rational frame rate', () => {
    expect(timelineFrameAt({ frame: 12, at: 1000 }, 2000, { num: 30000, den: 1001 }, 239)).toBe(41);
    expect(timelineFrameAt({ frame: 12, at: 1000 }, 2001, { num: 30000, den: 1001 }, 239)).toBe(42);
  });

  it('clamps at the final locatable frame', () => {
    expect(timelineFrameAt({ frame: 0, at: 0 }, 2000, { num: 24, den: 1 }, 47)).toBe(47);
    expect(timelineFrameAt({ frame: 47, at: 1000 }, 2000, { num: 24, den: 1 }, 47)).toBe(47);
  });

  it('clamps the anchor after the current sequence has become shorter', () => {
    expect(timelineFrameAt({ frame: 72, at: 1000 }, 1000, { num: 24, den: 1 }, 47)).toBe(47);
  });

  it('holds a one-frame sequence', () => {
    expect(timelineFrameAt({ frame: 0, at: 0 }, 100000, { num: 24, den: 1 }, 0)).toBe(0);
  });

  it('rebases after buffering so waiting time contributes no frames', () => {
    expect(timelineFrameAt({ frame: 24, at: 1000 }, 1250, { num: 24, den: 1 }, 239)).toBe(30);
    const resumed = Object.freeze({ frame: 30, at: 9000 });
    expect(timelineFrameAt(resumed, 9000, { num: 24, den: 1 }, 239)).toBe(30);
    expect(timelineFrameAt(resumed, 9250, { num: 24, den: 1 }, 239)).toBe(36);
    expect(resumed).toEqual({ frame: 30, at: 9000 });
  });

  it('computes each frame from the anchor independently of callback frequency', () => {
    const anchor = Object.freeze({ frame: 10, at: 1000 });
    for (const now of [1001, 1008, 1017, 1033, 1066, 1100, 1400, 1700]) {
      timelineFrameAt(anchor, now, { num: 30, den: 1 }, 239);
    }
    expect(timelineFrameAt(anchor, 2000, { num: 30, den: 1 }, 239)).toBe(40);
    expect(timelineFrameAt({ frame: 10, at: 1000 }, 2000, { num: 30, den: 1 }, 239)).toBe(40);
    expect(anchor).toEqual({ frame: 10, at: 1000 });
  });

  it('returns bounded integer frames in monotonic order', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 10000 }),
      fc.integer({ min: 0, max: 1000000 }),
      fc.integer({ min: 0, max: 10000 }),
      fc.integer({ min: 0, max: 1000000 }),
      fc.integer({ min: 0, max: 1000000 }),
      fc.constantFrom({ num: 24, den: 1 }, { num: 30, den: 1 }, { num: 30000, den: 1001 }),
      (frame, at, remaining, elapsed, later, fps) => {
        const endFrame = frame + remaining;
        const first = timelineFrameAt({ frame, at }, at + elapsed, fps, endFrame);
        const second = timelineFrameAt({ frame, at }, at + elapsed + later, fps, endFrame);
        expect(Number.isSafeInteger(first)).toBe(true);
        expect(Number.isSafeInteger(second)).toBe(true);
        expect(first).toBeGreaterThanOrEqual(frame);
        expect(second).toBeGreaterThanOrEqual(first);
        expect(second).toBeLessThanOrEqual(endFrame);
      },
    ));
  });
});
