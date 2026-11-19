// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import * as api from "../coco-rle.js";

// Byte fixtures were produced by the unmodified official COCO C reference.
const golden = [
  { height: 2, width: 3, counts: "6", expected: [255, 255, 255, 255, 255, 255] },
  { height: 2, width: 3, counts: "06", expected: [0, 0, 0, 0, 0, 0] },
  { height: 2, width: 3, counts: "213", expected: [255, 0, 255, 255, 255, 255] },
  { height: 2, width: 3, counts: "01200", expected: [0, 255, 255, 255, 0, 255] },
  { height: 3, width: 4, counts: "142M2", expected: [255, 0, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255] },
  { height: 1, width: 40, counts: "0d01]Oa0", expected: [...Array<number>(20).fill(0), 255, 0, ...Array<number>(18).fill(255)] },
];

// Execution design §10.3: the decoder lives in shared so the browser overlay and the containers read RLE the same way.
describe("COCO compressed RLE to VOID gray8 mask", () => {
  it("exports the mask decoder", () => {
    expect(["decodeCocoRleMask"].filter((name) => !(name in api))).toEqual([]);
  });

  it.each(golden)("decodes $height by $width compressed counts $counts into exact row-major VOID bytes", ({ height, width, counts, expected }) => {
    expect(Array.from(api.decodeCocoRleMask({ size: [height, width], counts }, { width, height }))).toEqual(expected);
  });

  it.each(["O", "011N", "5", "7", "", "P", "0d", "/", "p", "界", "0\0"])("rejects invalid compressed counts %j", (counts) => {
    expect(() => api.decodeCocoRleMask({ size: [2, 3], counts }, { width: 3, height: 2 })).toThrow();
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects an invalid height or width %s", (value) => {
    expect(() => api.decodeCocoRleMask({ size: [value, 3], counts: "6" }, { width: 3, height: 2 })).toThrow();
    expect(() => api.decodeCocoRleMask({ size: [2, value], counts: "6" }, { width: 3, height: 2 })).toThrow();
    expect(() => api.decodeCocoRleMask({ size: [2, 3], counts: "6" }, { width: value, height: 2 })).toThrow();
    expect(() => api.decodeCocoRleMask({ size: [2, 3], counts: "6" }, { width: 3, height: value })).toThrow();
  });

  it("rejects dimensions whose total differs from the compressed runs", () => {
    expect(() => api.decodeCocoRleMask({ size: [2, 4], counts: "6" }, { width: 4, height: 2 })).toThrow();
  });

  it("rejects transposed dimensions even when the total pixel count is unchanged", () => {
    expect(() => api.decodeCocoRleMask({ size: [3, 2], counts: "213" }, { width: 3, height: 2 })).toThrow();
  });
});
