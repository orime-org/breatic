// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { readYuNetFaces } from "@ingest/container/analysis-detection.js";

const cases = [
  { name: "Q1 landscape", size: [400, 200], raw: [40, 20, 80, 60], crop: { x: 40, y: 20, width: 80, height: 60 } },
  { name: "Q2 portrait", size: [200, 400], raw: [20, 40, 40, 120], crop: { x: 20, y: 40, width: 40, height: 120 } },
  { name: "Q3 odd source", size: [401, 201], raw: [40.1, 20.1, 80.2, 60.3], crop: { x: 40, y: 20, width: 81, height: 61 } },
  { name: "Q4 odd rectangle", size: [11, 9], raw: [3, 1, 5, 3], crop: { x: 3, y: 1, width: 5, height: 3 } },
  { name: "Q5 fractional edges", size: [11, 9], raw: [1.25, 2.25, 2.5, 3.5], crop: { x: 1, y: 2, width: 3, height: 4 } },
  { name: "Q6 endpoint coverage", size: [10, 10], raw: [2.75, 3.25, 1.5, 1.5], crop: { x: 2, y: 3, width: 3, height: 2 } },
  { name: "Q7 subpixel region", size: [10, 10], raw: [2.25, 3.25, 0.25, 0.5], crop: { x: 2, y: 3, width: 1, height: 1 } },
  { name: "Q8 top left", size: [7, 5], raw: [0, 0.25, 2.25, 1.5], crop: { x: 0, y: 0, width: 3, height: 2 } },
  { name: "Q9 bottom right", size: [7, 5], raw: [4.5, 2.5, 2.5, 2.5], crop: { x: 4, y: 2, width: 3, height: 3 } },
  { name: "Q10 whole frame", size: [7, 5], raw: [0, 0, 7, 5], crop: { x: 0, y: 0, width: 7, height: 5 } },
  { name: "Q11 last pixel", size: [7, 5], raw: [6, 4, 1, 1], crop: { x: 6, y: 4, width: 1, height: 1 } },
  { name: "Q12 exact endpoint", size: [10, 10], raw: [2.25, 3.5, 1.75, 1.5], crop: { x: 2, y: 3, width: 2, height: 2 } },
  { name: "Q13 clipped left", size: [7, 5], raw: [-0.5, 1.5, 2.25, 1.5], crop: { x: 0, y: 1, width: 2, height: 2 } },
  { name: "Q14 clipped bottom right", size: [7, 5], raw: [6.5, 4.5, 2, 2], crop: { x: 6, y: 4, width: 1, height: 1 } },
  { name: "Q15 true boundary below integer", size: [10, 10], raw: [1 - 2 ** -24, 2, 0.5, 1], crop: { x: 0, y: 2, width: 2, height: 1 } },
  { name: "Q16 true boundary above integer", size: [10, 10], raw: [0.5, 2, 0.5 + 2 ** -23, 1], crop: { x: 0, y: 2, width: 2, height: 1 } },
  { name: "original pixel 29", size: [100, 100], raw: [29, 0, 1, 1], crop: { x: 29, y: 0, width: 1, height: 1 } },
  { name: "original pixel 14", size: [100, 100], raw: [14, 0, 1, 1], crop: { x: 14, y: 0, width: 1, height: 1 } },
];

describe("saved detector pixel regions", () => {
  it.each(cases)("retains $name before normalized division", ({ size, raw, crop }) => {
    const dimensions = { width: size[0]!, height: size[1]! };
    const rows = [[...raw, ...Array<number>(10).fill(0), 0.9]];
    const previous = readYuNetFaces(rows, dimensions);
    const display = readYuNetFaces(rows, dimensions, true);
    expect(display).toEqual([{ ...previous[0], pixelCrop: crop }]);
    expect(previous[0]).not.toHaveProperty("pixelCrop");
  });

  it("preserves the already specified normalized landscape face box", () => {
    const row = [40, 20, 80, 60, ...Array<number>(10).fill(0), 0.9];
    expect(readYuNetFaces([row], { width: 400, height: 200 }, true)).toEqual([{ detectionIndex: 0,
      faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, pixelCrop: { x: 40, y: 20, width: 80, height: 60 } }]);
  });

  it("keeps surviving detection indices and their own clipped rectangle paired", () => {
    const rows = [[-0.5, 1.5, 2.25, 1.5], [7, 1, 1, 1], [6.5, 4.5, 2, 2]].map((row) => [...row, ...Array<number>(10).fill(0), 0.9]);
    expect(readYuNetFaces(rows, { width: 7, height: 5 }, true).map(({ detectionIndex, pixelCrop }) => ({ detectionIndex, pixelCrop }))).toEqual([
      { detectionIndex: 0, pixelCrop: { x: 0, y: 1, width: 2, height: 2 } }, { detectionIndex: 2, pixelCrop: { x: 6, y: 4, width: 1, height: 1 } },
    ]);
  });

  it.each([null, [], [[7, 1, 1, 1, ...Array<number>(10).fill(0), 0.9]], [[1, 1, 0, 1, ...Array<number>(10).fill(0), 0.9]]])("keeps empty detections empty", (rows) => {
    expect(readYuNetFaces(rows, { width: 7, height: 5 }, true)).toEqual([]);
  });

  it("keeps malformed detector rows as failures", () => {
    expect(() => readYuNetFaces([[1, 1, 1, 1, ...Array<number>(10).fill(0), Infinity]], { width: 7, height: 5 }, true)).toThrow();
  });
});
