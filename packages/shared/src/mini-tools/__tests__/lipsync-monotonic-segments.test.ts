// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 (frames-split design §5.4 待实测 row, `lipsync_clip` and `lipsync_composite` decode work): a shared function
 * splits the frozen lip-sync timeline's result-time to source-presentation-time mapping into forward and reverse monotonic
 * segments; each segment's decode work is the source frames it passes plus pre-roll (remap counts every source frame of
 * [0, V); a reverse segment is decoded per GOP forward once and output reversed, its pre-roll counted per GOP); composite
 * chunks may span segments (lipsync-disk-budget in domain covers their cutting).
 *
 * Shapes chosen here (the design names no function):
 * - `lipsyncMonotonicSegments(timeline, grid, prerollFrames)` returns
 *   `{ resultStart, resultEnd, sourceStart, sourceEnd, direction, prerollFrames }[]`, all in frames, ranges half-open.
 *   The result grid is the one the container writes: frame k at k / fps of the source grid,
 *   `ceil(round(duration · fps.numerator) / fps.denominator)` frames. The direction is the branch of
 *   `lipsyncSourceTickAt`: bounce is forward while u = t mod 2V is in [0, V] and reverse while u is in (V, 2V); loop starts
 *   a new forward segment where t mod V wraps to 0. `prerollFrames` is the tool source's decode pre-roll
 *   (`decodePrerollFrames`, frames-split §5.4 估算 row): there is no per-frame keyframe list on the grid, so each segment
 *   counts that pre-roll, never more than the frames before its first source frame.
 * Read from the mini-tools entry by name so this compiles before either exists.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type Mode = "cut_off" | "silence" | "loop" | "bounce" | "remap";
type Timeline = { duration: number; videoDuration: number; syncMode: Mode };
type Table = { fps: { numerator: number; denominator: number }; frameCount: number };
type Segment = { resultStart: number; resultEnd: number; sourceStart: number; sourceEnd: number; direction: "forward" | "reverse"; prerollFrames: number };
const api = miniTools as unknown as {
  lipsyncMonotonicSegments: (timeline: Timeline, table: Table, prerollFrames: number) => Segment[];
  lipsyncSourceFrameAt: (timeline: Timeline, table: Table, k: number) => number;
};

// Eighths of a second keep every result and source time exact in binary, so the frame mapping has no rounding to argue about.
const SCALE = 8;
/**
 * A grid of `count` frames of 1/8 s.
 * @param count - The frame count.
 * @returns The grid.
 */
const table = (count: number): Table => ({ fps: { numerator: SCALE, denominator: 1 }, frameCount: count });
// 48 frames of 1/8 s: V = 6, last frame 47; a 1.5 s keyframe interval gives 1.5 × 8 + 1 = 13 frames of pre-roll.
const TABLE = table(48);
const KEYS = 13;
/**
 * The source frame result frame k shows.
 * @param timeline - The timeline.
 * @param tab - The table.
 * @param k - The result frame.
 * @returns The source presentation frame.
 */
const sourceAt = (timeline: Timeline, tab: Table, k: number): number => api.lipsyncSourceFrameAt(timeline, tab, k);
/**
 * The result frames' source frames over [start, end).
 * @param timeline - The timeline.
 * @param tab - The table.
 * @param start - The first result frame.
 * @param end - The end result frame.
 * @returns The source frames.
 */
const shown = (timeline: Timeline, tab: Table, start: number, end: number): number[] => Array.from({ length: end - start }, (_, at) => sourceAt(timeline, tab, start + at));
const seg = (resultStart: number, resultEnd: number, sourceStart: number, sourceEnd: number, direction: Segment["direction"], prerollFrames = 0): Segment =>
  ({ resultStart, resultEnd, sourceStart, sourceEnd, direction, prerollFrames });

describe("lip-sync monotonic segments per mode (frames-split §5.4 待实测 row)", () => {
  it("MS01 cut_off is one forward segment over the frames it shows", () => {
    expect(api.lipsyncMonotonicSegments({ duration: 3, videoDuration: 6, syncMode: "cut_off" }, TABLE, KEYS)).toEqual([seg(0, 24, 0, 24, "forward")]);
  });

  it("MS02 silence is one forward segment; its tail holding the last frame passes no new source frame", () => {
    // 72 result frames, the last 24 holding frame 47: the decode still passes only the 48 source frames.
    expect(api.lipsyncMonotonicSegments({ duration: 9, videoDuration: 6, syncMode: "silence" }, TABLE, KEYS)).toEqual([seg(0, 72, 0, 48, "forward")]);
  });

  it("MS03 loop is one forward segment per period, the last one partial", () => {
    expect(api.lipsyncMonotonicSegments({ duration: 15, videoDuration: 6, syncMode: "loop" }, TABLE, KEYS))
      .toEqual([seg(0, 48, 0, 48, "forward"), seg(48, 96, 0, 48, "forward"), seg(96, 120, 0, 24, "forward")]);
  });

  it("MS04 bounce alternates forward and reverse, the turn at u = V staying in the forward segment", () => {
    // k = 48 is t = V (u = V, forward branch, last frame); k = 49 (u = 6.125) shows 5.875 → frame 47 going back;
    // k = 95 shows 0.125 → frame 1; k = 96 is t = 2V, u = 0, forward again; k = 119 shows 2.875 → frame 23.
    expect(api.lipsyncMonotonicSegments({ duration: 15, videoDuration: 6, syncMode: "bounce" }, TABLE, KEYS))
      .toEqual([seg(0, 49, 0, 48, "forward"), seg(49, 96, 1, 48, "reverse", 1), seg(96, 120, 0, 24, "forward")]);
  });

  it.each([
    ["compressing V into a shorter result", 3, 24],
    ["stretching V over a longer result", 9, 72],
  ] as const)("MS05 remap %s is one forward segment counting every source frame of [0, V)", (_name, duration, frames) => {
    // Compressed, result frame 23 shows only 5.75 → frame 46 and frames are skipped, yet all 48 are decoded.
    expect(api.lipsyncMonotonicSegments({ duration, videoDuration: 6, syncMode: "remap" }, TABLE, KEYS)).toEqual([seg(0, frames, 0, 48, "forward")]);
  });

  it("MS06 a segment counts the source's pre-roll once, never more than the frames before its first source frame", () => {
    // bounce over 10 s: the reverse segment k ∈ [49, 80) ends at 12 − 9.875 = 2.125 → frame 17; 13 frames of pre-roll fit.
    const segments = api.lipsyncMonotonicSegments({ duration: 10, videoDuration: 6, syncMode: "bounce" }, TABLE, KEYS);
    expect(segments).toEqual([seg(0, 49, 0, 48, "forward"), seg(49, 80, 17, 48, "reverse", 13)]);
    const reverse = segments[1]!;
    // Decode work: 31 passed source frames plus 13 of pre-roll.
    expect(reverse.sourceEnd - reverse.sourceStart + reverse.prerollFrames).toBe(44);
    // A longer keyframe interval than the frames before 17 decodes from the start: 17 frames.
    expect(api.lipsyncMonotonicSegments({ duration: 10, videoDuration: 6, syncMode: "bounce" }, TABLE, 25)[1]).toEqual(seg(49, 80, 17, 48, "reverse", 17));
    // An edit file has no pre-roll.
    expect(api.lipsyncMonotonicSegments({ duration: 10, videoDuration: 6, syncMode: "bounce" }, TABLE, 0)[1]).toEqual(seg(49, 80, 17, 48, "reverse", 0));
  });
});

describe("lip-sync monotonic segments for any timeline (property)", () => {
  const timelines = fc.record({
    // Two frames at least: a one-frame bounce has no reverse result frame, u never lying strictly inside (V, 2V) on the grid.
    frames: fc.integer({ min: 2, max: 40 }),
    resultFrames: fc.integer({ min: 1, max: 200 }),
    syncMode: fc.constantFrom<Mode>("cut_off", "silence", "loop", "bounce", "remap"),
    gop: fc.integer({ min: 1, max: 20 }),
  }).map(({ frames, resultFrames, syncMode, gop }) => ({
    tab: table(frames),
    keys: gop,
    // cut_off is min(V, A), so its result never outlasts the video.
    timeline: { duration: (syncMode === "cut_off" ? Math.min(frames, resultFrames) : resultFrames) / SCALE, videoDuration: frames / SCALE, syncMode },
  }));

  it("MS07 segments tile the result grid without gaps, each monotonic in its direction, passing exactly the frames it shows", () => {
    fc.assert(fc.property(timelines, ({ tab, keys, timeline }) => {
      const segments = api.lipsyncMonotonicSegments(timeline, tab, keys);
      const count = Math.round(timeline.duration * SCALE);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments[0]!.resultStart).toBe(0);
      expect(segments.at(-1)!.resultEnd).toBe(count);
      const frames = tab.frameCount;
      segments.forEach((segment, index) => {
        expect(segment.resultEnd).toBeGreaterThan(segment.resultStart);
        if (index > 0) expect(segment.resultStart).toBe(segments[index - 1]!.resultEnd);
        const sources = shown(timeline, tab, segment.resultStart, segment.resultEnd);
        for (let at = 1; at < sources.length; at += 1) {
          if (segment.direction === "forward") expect(sources[at]).toBeGreaterThanOrEqual(sources[at - 1]!);
          else expect(sources[at]).toBeLessThanOrEqual(sources[at - 1]!);
        }
        const range = timeline.syncMode === "remap" ? [0, frames] : [Math.min(...sources), Math.max(...sources) + 1];
        expect([segment.sourceStart, segment.sourceEnd]).toEqual(range);
        // Pre-roll: the source's, never more than the frames before the first passed frame.
        expect(segment.prerollFrames).toBe(Math.min(keys, segment.sourceStart));
      });
    }), { numRuns: 300 });
  });

  it("MS08 only bounce reverses, and its directions alternate; every other mode is forward only", () => {
    fc.assert(fc.property(timelines, ({ tab, keys, timeline }) => {
      const segments = api.lipsyncMonotonicSegments(timeline, tab, keys);
      const frames = tab.frameCount;
      const count = Math.round(timeline.duration * SCALE);
      if (timeline.syncMode === "bounce") {
        segments.forEach((segment, index) => expect(segment.direction).toBe(index % 2 === 0 ? "forward" : "reverse"));
        // Forward through u = V (frames + 1 result frames), then back for frames − 1, and so on.
        const ends: number[] = [];
        for (let turn = 0, at = 0; at < count; turn += 1) { at = Math.min(count, turn % 2 === 0 ? (turn / 2) * 2 * frames + frames + 1 : ((turn + 1) / 2) * 2 * frames); ends.push(at); }
        expect(segments.map((segment) => segment.resultEnd)).toEqual(ends);
      } else {
        expect(segments.every((segment) => segment.direction === "forward")).toBe(true);
        expect(segments.length).toBe(timeline.syncMode === "loop" ? Math.ceil(count / frames) : 1);
      }
    }), { numRuns: 300 });
  });

  // Clocks whose seconds are not exact in binary: a loop's periods and a bounce's turns still fall on whole periods of the
  // result grid, as on the 1/8 s clock above.
  it.each([[12800, 512], [30000, 1001], [90000, 3600]] as const)("MS09 on a %s clock with a step of %s, loop periods and bounce turns fall on whole frames", (timescale, step) => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 60 }), fc.integer({ min: 1, max: 400 }), fc.constantFrom<Mode>("loop", "bounce"), (frames, count, syncMode) => {
      const tab: Table = { fps: { numerator: timescale, denominator: step }, frameCount: frames };
      const segments = api.lipsyncMonotonicSegments({ duration: (count * step) / timescale, videoDuration: (frames * step) / timescale, syncMode }, tab, 0);
      const ends: number[] = [];
      if (syncMode === "loop") for (let at = frames; ; at += frames) { ends.push(Math.min(at, count)); if (at >= count) break; }
      else for (let turn = 0, at = 0; at < count; turn += 1) { at = Math.min(count, turn % 2 === 0 ? (turn / 2) * 2 * frames + frames + 1 : ((turn + 1) / 2) * 2 * frames); ends.push(at); }
      expect(segments.map((segment) => segment.resultEnd)).toEqual(ends);
    }), { numRuns: 200 });
  });
});
