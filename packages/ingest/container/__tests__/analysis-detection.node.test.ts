// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readSceneCutObservations, readYuNetFaces } from "../analysis-detection.js";

const row = [40, 20, 80, 60, 60, 40, 100, 40, 80, 50, 65, 65, 95, 65, 0.9];
const dimensions = { width: 400, height: 200 };
const sourceFrames = Array.from({ length: 60 }, (_, index) => ({ frameIndex: index, pts: (index * index + index) / 100 }));

/** Build another real fifteen-number row without deriving its expected output. */
function rectangle(x: number, y: number, width: number, height: number): number[] {
  return [x, y, width, height, ...row.slice(4)];
}

describe("owned YuNet candidates", () => {
  it("reads width and height from their actual row positions", () => {
    expect(readYuNetFaces([row], dimensions)).toEqual([
      { detectionIndex: 0, faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } },
    ]);
  });

  it.each([{ label: "null", value: null }, { label: "empty rows", value: [] }])("returns no placeholder people for $label", ({ value }) => {
    expect(readYuNetFaces(value, dimensions)).toEqual([]);
  });

  it("intersects the source, skips empty intersections and preserves detection ownership", () => {
    expect(readYuNetFaces([
      row, rectangle(-10, 190, 40, 20), rectangle(410, 10, 20, 20),
      rectangle(400, 20, 10, 20), rectangle(0, 0, 400, 200),
    ], dimensions)).toEqual([
      { detectionIndex: 0, faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } },
      { detectionIndex: 1, faceBox: { x: 0, y: 0.95, width: 0.075, height: 0.05 } },
      { detectionIndex: 4, faceBox: { x: 0, y: 0, width: 1, height: 1 } },
    ]);
  });

  it.each([
    { label: "missing output", value: undefined }, { label: "object", value: {} },
    { label: "short row", value: [row.slice(0, 14)] }, { label: "extra value", value: [[...row, 1]] },
    { label: "NaN coordinate", value: [rectangle(NaN, 20, 80, 60)] },
    { label: "infinite extent", value: [rectangle(40, 20, Infinity, 60)] },
    { label: "nonfinite landmark", value: [[...row.slice(0, 4), NaN, ...row.slice(5)]] },
    { label: "missing score", value: [[...row.slice(0, 14), null]] },
  ])("rejects $label instead of returning a partial successful analysis", ({ value }) => {
    expect(() => readYuNetFaces(value, dimensions)).toThrow(TypeError);
  });

  it.each([[0, 200], [400, 0], [-1, 200], [400, 1.5], [NaN, 200], [400, Infinity]])("rejects invalid source geometry %s by %s", (width, height) => {
    expect(() => readYuNetFaces([row], { width, height })).toThrow(TypeError);
  });

  it("keeps every retained fractional-pixel box within its source rectangle", () => {
    fc.assert(fc.property(
      fc.integer({ min: -1600, max: 1600 }), fc.integer({ min: -800, max: 800 }),
      fc.integer({ min: 0, max: 3200 }), fc.integer({ min: 0, max: 1600 }),
      (x, y, width, height) => {
        for (const candidate of readYuNetFaces([rectangle(x / 4, y / 4, width / 4, height / 4)], dimensions)) {
          expect(candidate.detectionIndex).toBe(0);
          expect(candidate.faceBox.x).toBeGreaterThanOrEqual(0);
          expect(candidate.faceBox.y).toBeGreaterThanOrEqual(0);
          expect(candidate.faceBox.width).toBeGreaterThan(0);
          expect(candidate.faceBox.height).toBeGreaterThan(0);
          expect(candidate.faceBox.x + candidate.faceBox.width).toBeLessThanOrEqual(1);
          expect(candidate.faceBox.y + candidate.faceBox.height).toBeLessThanOrEqual(1);
        }
      },
    ), { numRuns: 100 });
  });
});

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
