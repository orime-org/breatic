// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  gridSeekPosition,
  planFrameGrid,
} from "../frame-grid.js";
import type { FrameRate } from "../frame-grid-rate.js";

const FPS: FrameRate[] = [
  { numerator: 24000, denominator: 1001 }, { numerator: 24, denominator: 1 }, { numerator: 25, denominator: 1 },
  { numerator: 30000, denominator: 1001 }, { numerator: 30, denominator: 1 }, { numerator: 15, denominator: 2 },
  { numerator: 25, denominator: 2 }, { numerator: 60000, denominator: 1001 }, { numerator: 60, denominator: 1 },
  { numerator: 120, denominator: 1 },
];

const fpsArb = fc.constantFrom(...FPS);

/** A rational's value. */
function value(r: FrameRate): number {
  return r.numerator / r.denominator;
}

/** Milliseconds as an exact rational. */
function ms(n: number): FrameRate {
  return { numerator: n, denominator: 1000 };
}

describe("frame grid rules, property tests (frame-grid design §4.1)", () => {
  it("GE05: a video that starts late is padded from the grid start by its first frame", () => {
    fc.assert(
      fc.property(fpsArb, fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 20_000 }), (fps, videoMs, audioMs, lengthMs) => {
        const grid = planFrameGrid({
          fps, firstVideoTime: ms(videoMs), lastVideoTime: ms(videoMs + lengthMs), sourceFrames: 2,
          firstAudioFrameTime: ms(audioMs), audioEnd: ms(Math.max(videoMs, audioMs) + lengthMs), quantum: { numerator: 0, denominator: 1 }, singleFrameMs: 5000,
        });
        expect(value(grid.gridStart)).toBeCloseTo(Math.min(videoMs, audioMs) / 1000, 9);
        // round((firstVideo - gridStart) x fps), exactly, half away from zero.
        const late = BigInt(Math.max(0, videoMs - audioMs));
        const lead = (2n * late * BigInt(fps.numerator) + 1000n * BigInt(fps.denominator)) / (2000n * BigInt(fps.denominator));
        expect(grid.leadFrames).toBe(Number(lead));
      }),
    );
  });

  it("GE05: the last frame holds until the audio ends; without audio the grid stops at the last real frame", () => {
    fc.assert(
      fc.property(fpsArb, fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 0, max: 20_000 }), fc.boolean(), fc.constantFrom(0, 1), (fps, lengthMs, extraMs, audio, quantumMs) => {
        const grid = planFrameGrid({
          fps, firstVideoTime: ms(0), lastVideoTime: ms(lengthMs), sourceFrames: 2,
          firstAudioFrameTime: audio ? ms(0) : null, audioEnd: audio ? ms(lengthMs + extraMs) : null, quantum: ms(quantumMs), singleFrameMs: 5000,
        });
        expect(grid.holdFrames).toBe(grid.frameCount - grid.realFrameCount);
        expect(grid.holdFrames).toBeGreaterThanOrEqual(0);
        if (!audio) {
          expect(grid.holdFrames).toBe(0);
          expect(grid.gridEnd).toBeNull();
        } else {
          // The picture reaches the audio end, less at most one container quantum.
          expect(grid.frameCount / value(fps)).toBeGreaterThanOrEqual((lengthMs + extraMs - quantumMs) / 1000 - 1e-9);
        }
      }),
    );
  });

  it("GE05: a single-frame source without longer audio lasts 5 s", () => {
    fc.assert(
      fc.property(fpsArb, fc.integer({ min: 0, max: 10_000 }), (fps, startMs) => {
        const grid = planFrameGrid({
          fps, firstVideoTime: ms(startMs), lastVideoTime: ms(startMs), sourceFrames: 1,
          firstAudioFrameTime: null, audioEnd: null, quantum: { numerator: 0, denominator: 1 }, singleFrameMs: 5000,
        });
        expect(grid.realFrameCount).toBe(1);
        expect(grid.frameCount).toBe(Math.ceil(5 * value(fps) - 1e-9));
      }),
    );
  });
});

describe("frame-number conversion, property tests (frame-grid design §7.16)", () => {
  it("N01: the decode start is never later than the target frame's source time", () => {
    fc.assert(
      fc.property(
        fpsArb, fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 0, max: 30_000 }),
        fc.integer({ min: -500, max: 2000 }), fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 0, max: 12 }),
        (fps, startMs, realFrameCount, startFrame, earliestMs, intervalMs, attempt) => {
          const gridStart = ms(startMs);
          const position = gridSeekPosition({
            grid: { fps, gridStart, realFrameCount },
            keyframes: { earliestKeyframeTime: earliestMs / 1000, maxKeyframeInterval: intervalMs / 1000, allKeyframes: false },
            startFrame,
          }, attempt);
          if (position === null) return;
          const target = Math.min(startFrame, realFrameCount - 1);
          expect(position).toBeLessThanOrEqual(value(gridStart) + target / value(fps) + 1e-9);
          // A -ss position is never before the earliest keyframe packet plus max(largest interval, 3/23 s).
          expect(position).toBeGreaterThanOrEqual(earliestMs / 1000 + Math.max(intervalMs / 1000, 3 / 23) - 1e-9);
          // Each back-off seeks no later than the one before.
          if (attempt > 0) {
            const before = gridSeekPosition({
              grid: { fps, gridStart, realFrameCount },
              keyframes: { earliestKeyframeTime: earliestMs / 1000, maxKeyframeInterval: intervalMs / 1000, allKeyframes: false },
              startFrame,
            }, attempt - 1);
            if (before === null) throw new Error("a back-off seek follows a seek, never decoding from the start");
            expect(position).toBeLessThan(before);
          }
        },
      ),
    );
  });
});
