// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  durationToFrames,
  timelineSourceSeconds,
  validateTimelineRange,
} from "../time.js";

const fps = { num: 24, den: 1 };
const source = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "video" as const,
  assetId: "20000000-0000-4000-8000-000000000001",
  timebase: fps,
  extentFrames: 49,
  durationSeconds: "2.01",
  durationOrigin: "registered" as const,
};
const clip = {
  id: "30000000-0000-4000-8000-000000000001",
  trackId: "visual-1",
  kind: "video" as const,
  sourceId: source.id,
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 49,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};

describe("Timeline source duration in integer frames", () => {
  it.each([
    ["2", fps, 48],
    [2.01, fps, 49],
    ["0.00000001", fps, 1],
    ["1e-8", fps, 1],
    ["1.001", { num: 30000, den: 1001 }, 30],
    ["1e-1", { num: 30000, den: 1001 }, 3],
    ["9.007199254740991e15", { num: 1, den: 1 }, Number.MAX_SAFE_INTEGER],
  ] as const)("conforms %s seconds at %j to %i frames", (duration, timebase, expected) => {
    expect(durationToFrames(duration, timebase)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0", "-0.1", "not-a-number"])(
    "rejects a non-positive or non-finite duration %s",
    (duration) => {
      expect(() => durationToFrames(duration, fps)).toThrow(RangeError);
    },
  );

  it.each([
    { num: 0, den: 1 },
    { num: 24, den: 0 },
    { num: -24, den: 1 },
    { num: 24.5, den: 1 },
    { num: 24, den: 1.5 },
    { num: 24, den: Number.POSITIVE_INFINITY },
  ])("rejects an invalid rational timebase %j", (timebase) => {
    expect(() => durationToFrames("2", timebase)).toThrow(RangeError);
  });

  it("rejects an extent that cannot be represented as a safe integer", () => {
    expect(() => durationToFrames("9007199254740992", { num: 1, den: 1 })).toThrow(RangeError);
  });

  it("keeps the last sample inside the source and covers its full duration", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 100000 }),
      fc.integer({ min: 1, max: 120000 }),
      fc.integer({ min: 1, max: 1001 }),
      (milliseconds, num, den) => {
        const duration = `${Math.floor(milliseconds / 1000)}.${String(milliseconds % 1000).padStart(3, "0")}`;
        const frames = durationToFrames(duration, { num, den });
        const durationNumerator = BigInt(milliseconds) * BigInt(num);
        const frameDenominator = BigInt(1000) * BigInt(den);
        expect(Number.isSafeInteger(frames)).toBe(true);
        expect(frames).toBeGreaterThanOrEqual(1);
        expect(BigInt(frames - 1) * frameDenominator < durationNumerator).toBe(true);
        expect(BigInt(frames) * frameDenominator >= durationNumerator).toBe(true);
      },
    ));
  });
});

describe("Timeline source sampling", () => {
  it("combines the fixed source timebase, Timeline fps, in-point and speed", () => {
    const conformedSource = { ...source, timebase: { num: 30, den: 1 }, durationSeconds: "10", extentFrames: 300 };
    const placed = { ...clip, startFrame: 120, sourceInFrame: 60, durationFrames: 48, rate: { num: 3, den: 2 } };
    expect(timelineSourceSeconds(placed, conformedSource, fps, 120)).toBe(2);
    expect(timelineSourceSeconds(placed, conformedSource, fps, 144)).toBe(3.5);
  });

  it("preserves rational fps without accumulating earlier samples", () => {
    const ntsc = { num: 30000, den: 1001 };
    const conformedSource = { ...source, timebase: ntsc, durationSeconds: "200", extentFrames: 5995 };
    const placed = { ...clip, startFrame: 7, durationFrames: 3001 };
    expect(timelineSourceSeconds(placed, conformedSource, ntsc, 3007)).toBeCloseTo(100.1, 12);
    expect(timelineSourceSeconds(placed, conformedSource, ntsc, 7)).toBe(0);
    expect(timelineSourceSeconds(placed, conformedSource, ntsc, 1507)).toBeCloseTo(50.05, 12);
  });

  it.each([-1, 49, 50, 0.5])("rejects frame %s outside the integer half-open clip interval", (frame) => {
    expect(() => timelineSourceSeconds(clip, source, fps, frame)).toThrow(RangeError);
  });

  it("accepts the last partial frame but refuses a sample beyond the source", () => {
    expect(validateTimelineRange(clip, source, fps)).toEqual({ valid: true });
    expect(timelineSourceSeconds(clip, source, fps, 48)).toBe(2);
    expect(validateTimelineRange({ ...clip, durationFrames: 50 }, source, fps)).toEqual({ valid: false, reason: "invalid_range" });
  });

  it("uses the last visible sample rather than the exclusive frame tail", () => {
    expect(validateTimelineRange({ ...clip, sourceInFrame: 46, durationFrames: 3 }, source, fps)).toEqual({ valid: true });
    expect(validateTimelineRange({ ...clip, sourceInFrame: 49, durationFrames: 1 }, source, fps)).toEqual({ valid: false, reason: "invalid_range" });
    expect(validateTimelineRange({ ...clip, durationFrames: 25, rate: { num: 2, den: 1 } }, source, fps)).toEqual({ valid: true });
    expect(validateTimelineRange({ ...clip, durationFrames: 26, rate: { num: 2, den: 1 } }, source, fps)).toEqual({ valid: false, reason: "invalid_range" });
  });

  it.each([
    { startFrame: -1 },
    { startFrame: Number.MAX_SAFE_INTEGER, durationFrames: 1 },
    { sourceInFrame: -1 },
    { durationFrames: 0 },
    { durationFrames: 1.5 },
    { rate: { num: 0, den: 1 } },
    { rate: { num: 1, den: 0 } },
  ])("rejects invalid clip bounds %j", (changes) => {
    expect(validateTimelineRange({ ...clip, ...changes }, source, fps)).toEqual({ valid: false, reason: "invalid_range" });
  });
});
