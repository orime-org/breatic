// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import {
  parseTimelineFrame,
  timelineClipIntervalValid,
  timelineSourceSeconds,
  timelineTrimHead,
  validateTimelineRange,
} from '@web/data/yjs/timeline-time';

const fps = { num: 24, den: 1 };
const source = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'video' as const,
  assetId: '20000000-0000-4000-8000-000000000001',
  timebase: fps,
  extentFrames: 49,
  durationSeconds: '2.01',
  durationOrigin: 'registered' as const,
};
const clip = {
  id: '30000000-0000-4000-8000-000000000001',
  trackId: 'visual-1',
  kind: 'video' as const,
  sourceId: source.id,
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 49,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};

describe('Timeline source sampling', () => {
  it('combines the fixed source timebase, Timeline fps, in-point and speed', () => {
    const conformedSource = { ...source, timebase: { num: 30, den: 1 }, durationSeconds: '10', extentFrames: 300 };
    const placed = { ...clip, startFrame: 120, sourceInFrame: 60, durationFrames: 48, rate: { num: 3, den: 2 } };
    expect(timelineSourceSeconds(placed, conformedSource, fps, 120)).toBe(2);
    expect(timelineSourceSeconds(placed, conformedSource, fps, 144)).toBe(3.5);
  });

  it('preserves rational fps without accumulating earlier samples', () => {
    const ntsc = { num: 30000, den: 1001 };
    const conformedSource = { ...source, timebase: ntsc, durationSeconds: '200', extentFrames: 5995 };
    const placed = { ...clip, startFrame: 7, durationFrames: 3001 };
    expect(timelineSourceSeconds(placed, conformedSource, ntsc, 3007)).toBeCloseTo(100.1, 12);
    expect(timelineSourceSeconds(placed, conformedSource, ntsc, 7)).toBe(0);
    expect(timelineSourceSeconds(placed, conformedSource, ntsc, 1507)).toBeCloseTo(50.05, 12);
  });

  it.each([-1, 49, 50, 0.5])('rejects frame %s outside the integer half-open clip interval', (frame) => {
    expect(() => timelineSourceSeconds(clip, source, fps, frame)).toThrow(RangeError);
  });

  it('accepts the last partial frame but refuses a sample beyond the source', () => {
    expect(validateTimelineRange(clip, source, fps)).toEqual({ valid: true });
    expect(timelineSourceSeconds(clip, source, fps, 48)).toBe(2);
    expect(validateTimelineRange({ ...clip, durationFrames: 50 }, source, fps)).toEqual({ valid: false, reason: 'invalid_range' });
  });

  it('uses the last visible sample rather than the exclusive frame tail', () => {
    expect(validateTimelineRange({ ...clip, sourceInFrame: 46, durationFrames: 3 }, source, fps)).toEqual({ valid: true });
    expect(validateTimelineRange({ ...clip, sourceInFrame: 49, durationFrames: 1 }, source, fps)).toEqual({ valid: false, reason: 'invalid_range' });
    expect(validateTimelineRange({ ...clip, durationFrames: 25, rate: { num: 2, den: 1 } }, source, fps)).toEqual({ valid: true });
    expect(validateTimelineRange({ ...clip, durationFrames: 26, rate: { num: 2, den: 1 } }, source, fps)).toEqual({ valid: false, reason: 'invalid_range' });
  });

  it.each([
    { startFrame: -1 },
    { startFrame: Number.MAX_SAFE_INTEGER, durationFrames: 1 },
    { sourceInFrame: -1 },
    { durationFrames: 0 },
    { durationFrames: 1.5 },
    { rate: { num: 0, den: 1 } },
    { rate: { num: 1, den: 0 } },
  ])('rejects invalid clip bounds %j', (changes) => {
    expect(validateTimelineRange({ ...clip, ...changes }, source, fps)).toEqual({ valid: false, reason: 'invalid_range' });
  });
});

describe('timelineTrimHead (inner#1708 D4)', () => {
  const fps25 = { num: 25, den: 1 };
  /** 4 s at 50 frames per second. */
  const source50 = { ...source, timebase: { num: 50, den: 1 }, extentFrames: 200, durationSeconds: '4' };
  const placed = { ...clip, startFrame: 0, sourceInFrame: 0, durationFrames: 100 };

  it('converts a head move in Timeline frames to source frames', () => {
    expect(timelineTrimHead(placed, source50, fps25, 10)).toBe(20);
    expect(timelineTrimHead({ ...placed, sourceInFrame: 20 }, source50, fps25, -10)).toBe(0);
    expect(timelineTrimHead(placed, source50, fps25, 0)).toBe(0);
  });

  it('applies the clip speed', () => {
    expect(timelineTrimHead({ ...placed, rate: { num: 2, den: 1 } }, source50, fps25, 10)).toBe(40);
  });

  it('returns null for a head before the source start', () => {
    expect(timelineTrimHead({ ...placed, sourceInFrame: 20 }, source50, fps25, -11)).toBe(null);
    expect(timelineTrimHead(placed, source50, fps25, -1)).toBe(null);
  });

  it('returns null when the move is not a whole source frame', () => {
    // One Timeline frame at 25 fps is 24/25 of a frame of a 24 fps source.
    expect(timelineTrimHead(placed, source, fps25, 1)).toBe(null);
    expect(timelineTrimHead(placed, source, fps25, 25)).toBe(24);
  });
});

describe('timelineClipIntervalValid (inner#1708 Q2)', () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  it.each([
    ['the fixture clip', {}],
    ['a start at frame 0 and one frame', { startFrame: 0, durationFrames: 1 }],
    ['an end exactly at the largest safe integer', { startFrame: MAX - 1, durationFrames: 1 }],
    ['a large in-point', { sourceInFrame: MAX }],
  ])('accepts %s', (_name, changes) => {
    expect(timelineClipIntervalValid({ ...clip, ...changes })).toBe(true);
  });

  it.each([
    ['a negative start', { startFrame: -1 }],
    ['a fractional start', { startFrame: 0.5 }],
    ['a start beyond safe integers', { startFrame: MAX + 1 }],
    ['a negative in-point', { sourceInFrame: -1 }],
    ['a fractional in-point', { sourceInFrame: 1.5 }],
    ['an unsafe in-point', { sourceInFrame: MAX + 1 }],
    ['a zero duration', { durationFrames: 0 }],
    ['a negative duration', { durationFrames: -1 }],
    ['a fractional duration', { durationFrames: 1.5 }],
    ['a NaN duration', { durationFrames: Number.NaN }],
    ['an end past the largest safe integer', { startFrame: MAX, durationFrames: 1 }],
  ])('rejects %s', (_name, changes) => {
    expect(timelineClipIntervalValid({ ...clip, ...changes })).toBe(false);
  });
});

describe('parseTimelineFrame (inner#1708 R4)', () => {
  it.each([['0', 0], ['72', 72], [' 12 ', 12], ['007', 7]])('reads %j as %d', (text, frame) => {
    expect(parseTimelineFrame(text)).toBe(frame);
  });

  it.each(['', ' ', '1e3', '5.0', '-1', 'abc', '+5', '0x10', '1 2'])('reads %j as not a frame', (text) => {
    expect(parseTimelineFrame(text)).toBeNaN();
  });
});
