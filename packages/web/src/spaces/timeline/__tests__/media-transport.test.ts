// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, expectTypeOf, it } from 'vitest';
import fc from 'fast-check';

import { timelineFrameAt, type TimelineMediaTransport } from '@web/spaces/timeline/media-transport';

describe('TimelineMediaTransport', () => {
  it('has no failed state: a failure belongs to one video layer, never to the whole preview (#1410 design §6.2)', () => {
    expectTypeOf<TimelineMediaTransport>().toEqualTypeOf<'paused' | 'waiting' | 'playing'>();
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
