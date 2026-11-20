// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readSceneCutObservations } from "../analysis-detection.js";

const sourceFrames = Array.from({ length: 60 }, (_, index) => ({ frameIndex: index, pts: (index * index + index) / 100 }));

describe("source-clock scene observations", () => {
  it("preserves the VFR source cut and raw content_val above one", () => {
    expect(readSceneCutObservations([{ detectorFrameIndex: 30, detectionScore: 85 }], sourceFrames)).toEqual([
      { frameIndex: 30, pts: 9.3, detectionScore: 85 },
    ]);
  });

  it("maps a local range index back to the original source index", () => {
    expect(readSceneCutObservations([{ detectorFrameIndex: 20, detectionScore: 85 }], sourceFrames.slice(10, 50))).toEqual([
      { frameIndex: 30, pts: 9.3, detectionScore: 85 },
    ]);
  });

  it("uses the returned cut and its metric instead of the later processing cursor", () => {
    expect(readSceneCutObservations([{ detectorFrameIndex: 30, detectionScore: 85, processingFrameIndex: 35, currentScore: 0 }], sourceFrames)).toEqual([
      { frameIndex: 30, pts: 9.3, detectionScore: 85 },
    ]);
  });

  it("uses an explicit discontinuous mapping without inferring an offset", () => {
    expect(readSceneCutObservations([{ detectorFrameIndex: 1, detectionScore: 85 }], [
      { frameIndex: 1, pts: 0.0625 }, { frameIndex: 3, pts: 0.4375 }, { frameIndex: 6, pts: 3.4375 },
    ])).toEqual([{ frameIndex: 3, pts: 0.4375, detectionScore: 85 }]);
  });

  it("distinguishes no cuts in complete input from a missing source ledger", () => {
    expect(readSceneCutObservations([], sourceFrames)).toEqual([]);
    expect(() => readSceneCutObservations([], [])).toThrow(TypeError);
  });

  it.each([-1, 0.5, 60, NaN, Infinity, "30", undefined])("refuses unmappable detector index %s", (detectorFrameIndex) => {
    expect(() => readSceneCutObservations([{ detectorFrameIndex, detectionScore: 85 }], sourceFrames)).toThrow(TypeError);
  });

  it.each([undefined, null, NaN, Infinity, -Infinity, "85"])("does not invent a missing or nonfinite metric %s", (detectionScore) => {
    expect(() => readSceneCutObservations([{ detectorFrameIndex: 30, detectionScore }], sourceFrames)).toThrow(TypeError);
  });

  it("rejects duplicate observations for one cut", () => {
    expect(() => readSceneCutObservations([
      { detectorFrameIndex: 30, detectionScore: 85 }, { detectorFrameIndex: 30, detectionScore: 85 },
    ], sourceFrames)).toThrow(TypeError);
  });

  it.each([
    { label: "missing", value: undefined }, { label: "null", value: null },
    { label: "object", value: {} }, { label: "null item", value: [null] },
    { label: "foreign tuple", value: [[30, 85]] },
  ])("refuses $label scene observations", ({ value }) => {
    expect(() => readSceneCutObservations(value, sourceFrames)).toThrow(TypeError);
  });

  it.each([
    { frameIndex: -1, pts: 0 }, { frameIndex: 0.5, pts: 0 },
    { frameIndex: 9007199254740992, pts: 0 }, { frameIndex: 2, pts: NaN },
    { frameIndex: 2, pts: Infinity }, { frameIndex: 1, pts: 0.25 },
  ])("refuses a malformed frozen mapping even outside the selected cut: %j", (frame) => {
    expect(() => readSceneCutObservations([{ detectorFrameIndex: 0, detectionScore: 85 }], [
      { frameIndex: 1, pts: 0.125 }, frame,
    ])).toThrow(TypeError);
  });

  it("preserves exact mapped source facts for nonuniform frame sets", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 39 }), (index) => {
      const mapping = Array.from({ length: 40 }, (_, i) => ({ frameIndex: i * i + 1, pts: (i * i * i + 1) / 7 }));
      expect(readSceneCutObservations([{ detectorFrameIndex: index, detectionScore: 85 }], mapping)).toEqual([
        { frameIndex: index * index + 1, pts: (index * index * index + 1) / 7, detectionScore: 85 },
      ]);
    }), { numRuns: 80 });
  });
});
