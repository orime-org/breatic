// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { durationToFrames } from "@shared/timeline/time.js";

const fps = { num: 24, den: 1 };

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
