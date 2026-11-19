// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 execution design, the paragraph before §9.4: the lip-sync container steps stream raw frames through pipes.
 * Result frame k's source time is computed on whole ticks, so every loop and bounce cycle shows the frames the first one
 * shows. The clip decodes the prepared video once, forward, and crops into its crop file every source frame the result
 * uses after the decode has passed it, reading it back there; a composite chunk streams its source when its frames never go
 * back and decodes its union window to a raw file when they do. Admission and the container size raw pictures with one
 * function.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  lipsyncClipCropFrames, lipsyncPictureBytes, lipsyncResultSourceFrames, lipsyncSourceFrameAt, lipsyncSourceSpan, VIDEO_TOOL_SYNC_MODES, type LipsyncGrid, type LipsyncTimeline,
} from "@shared/mini-tools/lipsync-timeline.js";

/**
 * A frame grid (frames-split §4.1): every video is one, so the mapping runs on fps and frame count alone.
 * @param numerator - Its fps numerator (the clock: ticks a second).
 * @param count - Its frame count.
 * @param denominator - Its fps denominator (ticks a frame).
 * @returns The grid.
 */
const cfr = (numerator: number, count: number, denominator = 1): LipsyncGrid => ({ fps: { numerator, denominator }, frameCount: count });

describe("lip-sync raw pictures and the result grid (execution design paragraph before §9.4)", () => {
  it("LT01 a raw 8-bit 4:2:0 picture is its luma, two quarter chroma planes rounded up, and a luma-sized alpha plane when transparent", () => {
    expect(lipsyncPictureBytes(1920, 1080, false)).toBe(1920 * 1080 * 1.5);
    expect(lipsyncPictureBytes(1920, 1080, true)).toBe(1920 * 1080 * 2.5);
    expect(lipsyncPictureBytes(5, 3, false)).toBe(15 + 2 * 3 * 2);
  });

  it("LT02 the result grid is frame k at k / fps over ceil(round(duration · fps.numerator) / fps.denominator) frames", () => {
    const table = cfr(25, 10);
    const timeline: LipsyncTimeline = { duration: 0.72, videoDuration: 0.4, syncMode: "loop" };
    const sources = lipsyncResultSourceFrames(timeline, table);
    expect(sources).toEqual(Array.from({ length: 18 }, (_unused, k) => lipsyncSourceFrameAt(timeline, table, k)));
  });

  it("LT03 a window's source span is its lowest to highest source frame, going back when a later frame is lower than an earlier one", () => {
    const sources = [6, 7, 8, 9, 9, 9, 8, 7, 0, 1];
    expect(lipsyncSourceSpan(sources, { start: 0, end: 6 })).toEqual({ start: 6, end: 10, goesBack: false });
    expect(lipsyncSourceSpan(sources, { start: 3, end: 8 })).toEqual({ start: 7, end: 10, goesBack: true });
    expect(lipsyncSourceSpan(sources, { start: 8, end: 10 })).toEqual({ start: 0, end: 2, goesBack: false });
    expect(() => lipsyncSourceSpan(sources, { start: 4, end: 4 })).toThrow(RangeError);
  });

  // Frame clocks whose seconds are not exact in binary (25 fps on a 12800 clock, NTSC 30000/1001, ...), where a remainder
  // taken in float seconds lands just below a frame start and shows the frame before it.
  const CLOCKS = [[25, 1], [12800, 512], [90000, 3600], [30000, 1001], [24000, 1001], [600, 20]] as const;

  it.each(["loop", "bounce", "remap"] as const)("LT04 %s: result frame k shows the frame whole-tick arithmetic gives, every cycle as the first", (syncMode) => {
    fc.assert(fc.property(
      fc.constantFrom(...CLOCKS), fc.integer({ min: 1, max: 300 }), fc.integer({ min: 1, max: 1500 }),
      ([timescale, step], frames, resultFrames) => {
        const table = cfr(timescale, frames, step);
        const [v, d] = [frames * step, resultFrames * step];
        const sources = lipsyncResultSourceFrames({ duration: d / timescale, videoDuration: v / timescale, syncMode }, table);
        const expected = Array.from({ length: resultFrames }, (_unused, k) => {
          const tick = k * step;
          const u = tick % (2 * v);
          const shown = syncMode === "loop" ? tick % v : syncMode === "bounce" ? (u <= v ? u : 2 * v - u) : Math.floor((tick * v) / d);
          return Math.min(Math.floor(shown / step), frames - 1);
        });
        expect(sources).toEqual(expected);
      },
    ), { numRuns: 300 });
  });

  it("LT05 the crop file holds each frame the result shows again and each frame first shown after a later one", () => {
    expect(lipsyncClipCropFrames([0, 2, 1, 2])).toEqual([1, 2]);
    expect(lipsyncClipCropFrames([0, 1, 2, 3])).toEqual([]);
    expect(lipsyncClipCropFrames([0, 1, 1, 0, 3])).toEqual([0, 1]);
  });

  /**
   * A frame grid on a 600 clock at one of several rates.
   * @returns The grid arbitrary.
   */
  const grids = (): fc.Arbitrary<LipsyncGrid> => fc.record({ count: fc.integer({ min: 1, max: 120 }), step: fc.constantFrom(10, 12, 20, 24, 25) })
    .map(({ count, step }) => cfr(600, count, step));

  // The clip's single forward decode: walking the result in order, a source frame not in the crop file is always ahead of the
  // decode, and every crop the file holds is read back at least once.
  it.each(VIDEO_TOOL_SYNC_MODES)("LT06 %s: one forward decode with the crop file serves every result frame", (syncMode) => {
    fc.assert(fc.property(grids(), fc.integer({ min: 1, max: 600 }), (grid, resultFrames) => {
      const step = grid.fps.denominator;
      const end = grid.frameCount * step;
      const duration = syncMode === "cut_off" ? Math.min(end, resultFrames * step) / grid.fps.numerator : (resultFrames * step) / grid.fps.numerator;
      const sources = lipsyncResultSourceFrames({ duration, videoDuration: end / grid.fps.numerator, syncMode }, grid);
      const kept = new Set(lipsyncClipCropFrames(sources));
      const stored = new Set<number>();
      const reads = new Map<number, number>();
      let position = -1;
      for (const s of sources) {
        if (stored.has(s)) { reads.set(s, (reads.get(s) ?? 0) + 1); continue; }
        expect(s, `frame ${s} after the decode passed ${position}`).toBeGreaterThan(position);
        while (position < s) { position += 1; if (kept.has(position)) stored.add(position); }
      }
      for (const frame of kept) expect(reads.get(frame), `crop ${frame} is read back`).toBeGreaterThan(0);
    }), { numRuns: 300 });
  });
});
