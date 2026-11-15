// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The source frames a transition chunk shows (frames-split design §7.17 transition output profile row: each clip takes, at
 * output frame k, the source frame covering that moment), shared by the admission estimate and the worker's chunk cut.
 */
import { describe, expect, it } from "vitest";
import type { VideoPresentationTable } from "@breatic/shared/mini-tools";
import { presentationFrameCovering, transitionSourceWindow } from "@domain/mini-tool/transition-source-window.js";

// 120 frames at 60 fps, then 10 frames held twice as long after a gap of one tick.
const TABLE: VideoPresentationTable = { schemaVersion: 1, timescale: 60, runs: [{ start: 0, count: 120, step: 1, duration: 1 }, { start: 121, count: 10, step: 2, duration: 2 }] };
const TWENTY_FIVE = { numerator: "25", denominator: "1" };

describe("transitionSourceWindow", () => {
  it("TSW01 a chunk starting at output frame 1 of 25 fps starts on the 60 fps frame shown at 1/25 s, not at the output frame's middle", () => {
    // 1/25 s is 2.4 source frames in: frame 2 covers it; the middle of output frame 1 (0.06 s) lies in frame 3.
    expect(transitionSourceWindow(TABLE, { inFrame: 0, startFrame: 0 }, { start: 1, end: 3 }, TWENTY_FIVE)).toEqual({ start: 2, end: 5 });
  });

  it("TSW02 the clip's In frame and grid start shift the slot time", () => {
    // Output frame 10 of a clip placed at output frame 4 with In frame 6 shows its frame 12, at 12/25 s = 28.8 source frames.
    expect(transitionSourceWindow(TABLE, { inFrame: 6, startFrame: 4 }, { start: 10, end: 11 }, TWENTY_FIVE)).toEqual({ start: 28, end: 29 });
  });
});

describe("presentationFrameCovering", () => {
  it("TSW03 a time on a frame's start is that frame, one tick before is the frame before", () => {
    expect(presentationFrameCovering(TABLE, [30n, 60n])).toBe(30);
    expect(presentationFrameCovering(TABLE, [29n * 1000n + 999n, 60_000n])).toBe(29);
  });

  it("TSW04 a run of held frames counts from its first frame on", () => {
    // Second run: frame 120 shows during [121, 123) ticks, frame 121 during [123, 125).
    expect(presentationFrameCovering(TABLE, [122n, 60n])).toBe(120);
    expect(presentationFrameCovering(TABLE, [124n, 60n])).toBe(121);
  });

  it("TSW05 a time in no frame is refused: before the first, in the gap, at or after the last frame's end", () => {
    expect(() => presentationFrameCovering(TABLE, [-1n, 60n])).toThrow(RangeError);
    expect(() => presentationFrameCovering(TABLE, [241n, 120n])).toThrow(RangeError);
    expect(() => presentationFrameCovering(TABLE, [141n, 60n])).toThrow(RangeError);
  });
});

/**
 * A CFR table whose frame starts are rounded to a 1 ms clock, as a WebM stores them.
 * @param rate - The true rate as numerator and denominator.
 * @param count - The frames.
 * @returns The table.
 */
function webm(rate: readonly [number, number], count: number): VideoPresentationTable {
  const starts = Array.from({ length: count + 1 }, (_unused, k) => Math.round((k * rate[1] * 1000) / rate[0]));
  return { schemaVersion: 1, timescale: 1000, runs: starts.slice(0, count).map((start, k) => ({ start, count: 1, step: starts[k + 1]! - start, duration: starts[k + 1]! - start })) };
}

/**
 * The frames a clip at In 0 shows on an output grid, one per output frame.
 * @param table - The clip's table.
 * @param fps - The output rate.
 * @param count - The output frames.
 * @returns The shown frames.
 */
function shown(table: VideoPresentationTable, fps: { numerator: string; denominator: string }, count: number): number[] {
  return Array.from({ length: count }, (_unused, k) => transitionSourceWindow(table, { inFrame: 0, startFrame: 0 }, { start: k, end: k + 1 }, fps).start);
}

// A WebM stores frame starts rounded to its 1 ms clock (30 fps: 0, 33, 67, 100 ms...); each frame truly starts on its exact
// grid point, and that is where it covers output frames (§7.17 rounding clock row).
describe("frames whose starts are rounded to the source clock (frames-split §7.17)", () => {
  it("TSW06 a time just before a rounded start still shows the frame before; the exact grid point shows the frame", () => {
    const table = webm([30, 1], 30);
    expect(presentationFrameCovering(table, [2n, 30n])).toBe(2);
    expect(presentationFrameCovering(table, [2n * 1000n - 1n, 30_000n])).toBe(1);
  });

  it("TSW07 a 30 fps WebM on a 30 fps grid shows every frame once", () => {
    expect(shown(webm([30, 1], 30), { numerator: "30", denominator: "1" }, 30)).toEqual(Array.from({ length: 30 }, (_unused, k) => k));
  });

  it.each<[string, readonly [number, number], { numerator: string; denominator: string }, (k: number) => number]>([
    ["a 29.97 fps WebM on a 30 fps grid", [30000, 1001], { numerator: "30", denominator: "1" }, (k) => Math.floor((k * 1000) / 1001)],
    ["a 30 fps WebM on a 29.97 fps grid", [30, 1], { numerator: "30000", denominator: "1001" }, (k) => Math.floor((k * 1001) / 1000)],
    ["a 23.976 fps WebM on a 24 fps grid", [24000, 1001], { numerator: "24", denominator: "1" }, (k) => Math.floor((k * 1000) / 1001)],
    ["a 59.94 fps WebM on a 29.97 fps grid", [60000, 1001], { numerator: "30000", denominator: "1001" }, (k) => 2 * k],
  ])("TSW08 %s shows the frame truly covering each output frame", (_name, rate, fps, expected) => {
    expect(shown(webm(rate, 1200), fps, 590)).toEqual(Array.from({ length: 590 }, (_unused, k) => expected(k)));
  });

  it("TSW09 the last frame still ends at its stored end", () => {
    const table = webm([30, 1], 30);
    expect(presentationFrameCovering(table, [999n, 1000n])).toBe(29);
    expect(() => presentationFrameCovering(table, [1n, 1n])).toThrow(RangeError);
  });
});
