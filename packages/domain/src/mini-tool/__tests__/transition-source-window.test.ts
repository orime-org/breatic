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

// A 30 fps WebM stores frame starts rounded to its 1 ms clock (0, 33, 67, 100 ms...): frame 2 truly starts at 66.67 ms.
const WEBM30: VideoPresentationTable = { schemaVersion: 1, timescale: 1000, runs: Array.from({ length: 30 }, (_unused, k) => {
  const [start, next] = [Math.round((k * 1000) / 30), Math.round(((k + 1) * 1000) / 30)];
  return { start, count: 1, step: next - start, duration: next - start };
}) };
const HALF_MS: readonly [bigint, bigint] = [1n, 2000n];

describe("frames whose starts are rounded to the source clock (frames-split §7.17; round 26)", () => {
  it("TSW06 a start at most half a source tick after the slot time covers that slot", () => {
    expect(presentationFrameCovering(WEBM30, [2n, 30n], HALF_MS)).toBe(2);
    expect(presentationFrameCovering(WEBM30, [2n, 30n])).toBe(1);
  });

  it("TSW07 a 30 fps WebM on a 30 fps grid shows every frame once", () => {
    const shown = Array.from({ length: 30 }, (_unused, k) => transitionSourceWindow(WEBM30, { inFrame: 0, startFrame: 0 }, { start: k, end: k + 1 }, { numerator: "30", denominator: "1" }, HALF_MS).start);
    expect(shown).toEqual(Array.from({ length: 30 }, (_unused, k) => k));
  });
});

