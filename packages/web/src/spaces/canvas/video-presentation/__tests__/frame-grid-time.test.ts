// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §69 U02 (frames-split design §4.3 "浏览器取帧号与跳帧"): the browser's current frame number is the
 * last requestVideoFrameCallback mediaTime times fps, rounded and held to [0, frameCount − 1], never derived from
 * `currentTime`; every jump to a frame (player, split cuts, range handles, transition In/Out, preview cards) seeks the
 * frame's midpoint (i + 0.5) / fps. Chrome 157 measured: jumping to i / fps shows the previous frame about a third of the
 * time, and `currentTime` is truncated to microseconds.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { frameIndexOfMediaTime, frameMidpointSeconds } from '../frame-grid-time';

const RATES = [{ numerator: 24000, denominator: 1001 }, { numerator: 25, denominator: 1 }, { numerator: 30000, denominator: 1001 }, { numerator: 30, denominator: 1 }, { numerator: 60, denominator: 1 }, { numerator: 120, denominator: 1 }];

describe('U02 frame numbers and frame jumps on the grid (§4.3)', () => {
  it('U02: a jump to frame i seeks its midpoint (i + 0.5) / fps', () => {
    expect(frameMidpointSeconds(0, { numerator: 30, denominator: 1 })).toBeCloseTo(1 / 60, 12);
    expect(frameMidpointSeconds(7, { numerator: 30, denominator: 1 })).toBeCloseTo(0.25, 12);
    expect(frameMidpointSeconds(10, { numerator: 30000, denominator: 1001 })).toBeCloseTo(10.5 * 1001 / 30000, 12);
  });

  it('U02: the midpoint lies strictly inside frame i, never on its start boundary (property)', () => {
    fc.assert(fc.property(fc.constantFrom(...RATES), fc.integer({ min: 0, max: 500_000 }), (fps, index) => {
      const seconds = frameMidpointSeconds(index, fps);
      const position = seconds * fps.numerator / fps.denominator;
      expect(position).toBeGreaterThan(index);
      expect(position).toBeLessThan(index + 1);
    }), { seed: 130602, numRuns: 300 });
  });

  it('U02: the frame number is round(mediaTime × fps), held to [0, frameCount − 1]', () => {
    const grid = { fps: { numerator: 30, denominator: 1 }, frameCount: 90 };
    expect(frameIndexOfMediaTime(0, grid)).toBe(0);
    expect(frameIndexOfMediaTime(7 / 30, grid)).toBe(7);
    expect(frameIndexOfMediaTime(89 / 30, grid)).toBe(89);
    expect(frameIndexOfMediaTime(3.5, grid)).toBe(89);
    expect(frameIndexOfMediaTime(-0.01, grid)).toBe(0);
  });

  it('U02: a mediaTime on frame i, truncated to microseconds as Chrome reports it, still reads frame i (property)', () => {
    fc.assert(fc.property(fc.constantFrom(...RATES), fc.integer({ min: 0, max: 200_000 }), (fps, index) => {
      const exact = index * fps.denominator / fps.numerator;
      const truncated = Math.trunc(exact * 1e6) / 1e6;
      expect(frameIndexOfMediaTime(truncated, { fps, frameCount: index + 1 })).toBe(index);
    }), { seed: 130603, numRuns: 300 });
  });

  it('U02: reading the midpoint a jump seeks gives back the same frame (property)', () => {
    fc.assert(fc.property(fc.constantFrom(...RATES), fc.integer({ min: 1, max: 100_000 }), fc.nat(), (fps, frameCount, pick) => {
      const index = pick % frameCount;
      // The browser presents the frame whose timestamp is the frame start; rVFC reports that start as mediaTime.
      const presented = Math.floor(frameMidpointSeconds(index, fps) * fps.numerator / fps.denominator) * fps.denominator / fps.numerator;
      expect(frameIndexOfMediaTime(presented, { fps, frameCount })).toBe(index);
    }), { seed: 130604, numRuns: 300 });
  });
});
