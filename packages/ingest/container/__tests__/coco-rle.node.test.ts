// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import * as api from "../coco-rle";

// Byte fixtures were produced by the unmodified official COCO C reference.
const golden = [
  { height: 2, width: 3, counts: "6", expected: [255, 255, 255, 255, 255, 255] },
  { height: 2, width: 3, counts: "06", expected: [0, 0, 0, 0, 0, 0] },
  { height: 2, width: 3, counts: "213", expected: [255, 0, 255, 255, 255, 255] },
  { height: 2, width: 3, counts: "01200", expected: [0, 255, 255, 255, 0, 255] },
  { height: 3, width: 4, counts: "142M2", expected: [255, 0, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255] },
  { height: 1, width: 40, counts: "0d01]Oa0", expected: [...Array<number>(20).fill(0), 255, 0, ...Array<number>(18).fill(255)] },
];

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

// inner#1306 test plan §97 D17-7 (a) (execution design §9.4 no_face row: 「track在用到的源区间内整段都是空前景」): on top of the
// decoder, `trackedForegroundEmpty(masks, range, expected)` says whether a person's SAM3 track has no foreground pixel on
// any frame in the used source range [start, end); a frame without a mask counts as empty. §97 D18-3: the SAM3 RLE file is a
// JSON array of compressed counts, one per frame of the prepared video in order (a measured 150-frame SAM3 track holds 150
// entries and no explicit frame index), so the array index is the frame index;
// the container builds each mask from the counts and the prepared video's size. `lipsync_faces` then reports
// `empty_foreground`.
describe("an empty tracked foreground over the used range (§97 D17-7)", () => {
  type Empty = (masks: readonly (api.CocoRleMask | null)[], range: { start: number; end: number }, expected: { width: number; height: number }) => boolean;
  const empty = (api as unknown as { trackedForegroundEmpty?: Empty }).trackedForegroundEmpty;
  const SIZE = { width: 3, height: 2 };
  const background: api.CocoRleMask = { size: [2, 3], counts: "6" };
  const foreground: api.CocoRleMask = { size: [2, 3], counts: "213" };

  it.each([
    ["every frame in the range is background", [background, background, background], { start: 0, end: 3 }, true],
    ["one frame in the range has foreground", [background, foreground, background], { start: 0, end: 3 }, false],
    ["foreground only outside the range", [foreground, background, background, foreground], { start: 1, end: 3 }, true],
    ["frames without a mask in the range", [background, null, null], { start: 1, end: 3 }, true],
    ["a frame without a mask beside one with foreground", [null, foreground], { start: 0, end: 2 }, false],
  ] as const)("RL01 %s", (_name, masks, range, expected) => {
    expect(empty, "trackedForegroundEmpty is exported from coco-rle").toBeTypeOf("function");
    expect(empty!(masks, range, SIZE)).toBe(expected);
  });
});
