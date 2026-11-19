// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The grid frames a transition chunk shows (frames-split design §7.17 transition output profile row: each clip takes, at
 * output frame k, the grid frame covering that moment; §4.1: grid frame i covers [i/fps, (i+1)/fps)), shared by the
 * admission estimate and the worker's chunk cut.
 */
import { describe, expect, it } from "vitest";
import { gridFrameCovering, transitionSourceWindow } from "@domain/mini-tool/transition-source-window.js";

const SIXTY = { fps: { numerator: 60, denominator: 1 }, frameCount: 130 };
const TWENTY_FIVE = { numerator: 25, denominator: 1 };

describe("transitionSourceWindow", () => {
  it("TSW01 a chunk starting at output frame 1 of 25 fps starts on the 60 fps frame shown at 1/25 s", () => {
    // 1/25 s is 2.4 grid frames in: frame 2 covers it; output frame 2 (4.8 frames in) is frame 4.
    expect(transitionSourceWindow(SIXTY, { inFrame: 0, startFrame: 0 }, { start: 1, end: 3 }, TWENTY_FIVE)).toEqual({ start: 2, end: 5 });
  });

  it("TSW02 the clip's In frame and its first output frame shift the slot time", () => {
    // Output frame 10 of a clip placed at output frame 4 with In frame 6 shows its frame 12, at 12/25 s = 28.8 grid frames.
    expect(transitionSourceWindow(SIXTY, { inFrame: 6, startFrame: 4 }, { start: 10, end: 11 }, TWENTY_FIVE)).toEqual({ start: 28, end: 29 });
  });
});

describe("gridFrameCovering", () => {
  it("TSW03 a time on a frame's start is that frame, a moment before is the frame before", () => {
    expect(gridFrameCovering(SIXTY, [30n, 60n])).toBe(30);
    expect(gridFrameCovering(SIXTY, [29n * 1000n + 999n, 60_000n])).toBe(29);
  });

  it("TSW05 a time outside the grid is refused: before it, or at or after the last frame's end", () => {
    expect(() => gridFrameCovering(SIXTY, [-1n, 60n])).toThrow(RangeError);
    expect(() => gridFrameCovering(SIXTY, [130n, 60n])).toThrow(RangeError);
    expect(gridFrameCovering(SIXTY, [1299n, 600n])).toBe(129);
  });
});

/**
 * The grid frames a clip at In 0 shows on an output grid, one per output frame.
 * @param grid - The clip's grid.
 * @param grid.fps - Its rate.
 * @param grid.frameCount - Its frames.
 * @param fps - The output rate.
 * @param count - The output frames.
 * @returns The shown frames.
 */
function shown(grid: { fps: { numerator: number; denominator: number }; frameCount: number }, fps: { numerator: number; denominator: number }, count: number): number[] {
  return Array.from({ length: count }, (_unused, k) => transitionSourceWindow(grid, { inFrame: 0, startFrame: 0 }, { start: k, end: k + 1 }, fps).start);
}

describe("clips whose grid rate differs from the output rate (frames-split §7.17)", () => {
  it("TSW07 a 30 fps grid on a 30 fps output shows every frame once", () => {
    expect(shown({ fps: { numerator: 30, denominator: 1 }, frameCount: 30 }, { numerator: 30, denominator: 1 }, 30)).toEqual(Array.from({ length: 30 }, (_unused, k) => k));
  });

  it.each<[string, { numerator: number; denominator: number }, { numerator: number; denominator: number }, (k: number) => number]>([
    ["a 29.97 fps grid on a 30 fps output", { numerator: 30000, denominator: 1001 }, { numerator: 30, denominator: 1 }, (k) => Math.floor((k * 1000) / 1001)],
    ["a 30 fps grid on a 29.97 fps output", { numerator: 30, denominator: 1 }, { numerator: 30000, denominator: 1001 }, (k) => Math.floor((k * 1001) / 1000)],
    ["a 23.976 fps grid on a 24 fps output", { numerator: 24000, denominator: 1001 }, { numerator: 24, denominator: 1 }, (k) => Math.floor((k * 1000) / 1001)],
    ["a 59.94 fps grid on a 29.97 fps output", { numerator: 60000, denominator: 1001 }, { numerator: 30000, denominator: 1001 }, (k) => 2 * k],
  ])("TSW08 %s shows the frame covering each output frame", (_name, rate, fps, expected) => {
    expect(shown({ fps: rate, frameCount: 1200 }, fps, 590)).toEqual(Array.from({ length: 590 }, (_unused, k) => expected(k)));
  });
});
