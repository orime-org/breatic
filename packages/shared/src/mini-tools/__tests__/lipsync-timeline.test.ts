// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 execution design, the paragraph before §9.4: the lip-sync container steps stream raw frames through pipes.
 * The clip decodes the prepared video once, forward, and reads a reused source frame's crop back from its crop file, which
 * holds only because the first use of each source frame never goes back on the result grid; a composite chunk streams its
 * source when its frames never go back and decodes its union window to a raw file when they do. Admission and the
 * container size raw pictures with one function.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  lipsyncPictureBytes, lipsyncResultSourceFrames, lipsyncSourceFrameAt, lipsyncSourceSpan, VIDEO_TOOL_SYNC_MODES, type LipsyncTimeline,
} from "@shared/mini-tools/lipsync-timeline.js";
import type { VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";

/**
 * A constant-rate table.
 * @param fps - Its frame rate.
 * @param count - Its frame count.
 * @returns The table.
 */
const cfr = (fps: number, count: number): VideoPresentationTable => ({ schemaVersion: 1, timescale: fps, runs: [{ start: 0, count, step: 1, duration: 1 }] });

describe("lip-sync raw pictures and the result grid (execution design paragraph before §9.4)", () => {
  it("LT01 a raw 8-bit 4:2:0 picture is its luma, two quarter chroma planes rounded up, and a luma-sized alpha plane when transparent", () => {
    expect(lipsyncPictureBytes(1920, 1080, false)).toBe(1920 * 1080 * 1.5);
    expect(lipsyncPictureBytes(1920, 1080, true)).toBe(1920 * 1080 * 2.5);
    expect(lipsyncPictureBytes(5, 3, false)).toBe(15 + 2 * 3 * 2);
  });

  it("LT02 the result grid is frame k at k · step / timescale over ceil(round(duration · timescale) / step) frames", () => {
    const table = cfr(25, 10);
    const timeline: LipsyncTimeline = { duration: 0.72, videoDuration: 0.4, syncMode: "loop" };
    const sources = lipsyncResultSourceFrames(timeline, table);
    expect(sources).toEqual(Array.from({ length: 18 }, (_unused, k) => lipsyncSourceFrameAt(timeline, table, k / 25)));
  });

  it("LT03 a window's source span is its lowest to highest source frame, going back when a later frame is lower than an earlier one", () => {
    const sources = [6, 7, 8, 9, 9, 9, 8, 7, 0, 1];
    expect(lipsyncSourceSpan(sources, { start: 0, end: 6 })).toEqual({ start: 6, end: 10, goesBack: false });
    expect(lipsyncSourceSpan(sources, { start: 3, end: 8 })).toEqual({ start: 7, end: 10, goesBack: true });
    expect(lipsyncSourceSpan(sources, { start: 8, end: 10 })).toEqual({ start: 0, end: 2, goesBack: false });
    expect(() => lipsyncSourceSpan(sources, { start: 4, end: 4 })).toThrow(RangeError);
  });

  // The clip's single forward decode rests on this: in every sync mode, each source frame's first use on the result grid
  // comes after the first use of every lower frame the result uses, so the decoder never has to go back for a frame it has
  // not cropped yet.
  it.each(VIDEO_TOOL_SYNC_MODES)("LT04 %s: the first uses of the source frames never go back", (syncMode) => {
    fc.assert(fc.property(
      fc.constantFrom(24, 25, 30, 50, 60), fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 1200 }),
      (fps, frames, resultFrames) => {
        const table = cfr(fps, frames);
        const videoDuration = frames / fps;
        const duration = syncMode === "cut_off" ? Math.min(videoDuration, resultFrames / fps) : resultFrames / fps;
        const sources = lipsyncResultSourceFrames({ duration, videoDuration, syncMode }, table);
        const firsts: number[] = [];
        const seen = new Set<number>();
        for (const frame of sources) if (!seen.has(frame)) { seen.add(frame); firsts.push(frame); }
        for (let at = 1; at < firsts.length; at += 1) expect(firsts[at]!, `first uses ${JSON.stringify(firsts)}`).toBeGreaterThan(firsts[at - 1]!);
      },
    ), { numRuns: 300 });
  });
});
