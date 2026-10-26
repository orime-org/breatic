// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { readMiniToolSam3Output } from "../read-sam3-output.js";

const rle = "https://provider.test.invalid/original/rle.json?signature=original";
const preview = "https://provider.test.invalid/original/preview.mp4?signature=original";

describe("original SAM3 paired output", () => {
  it("retains both URLs from the same structured output item", () => {
    expect(readMiniToolSam3Output([{ rle_url: rle, video_url: preview }])).toEqual({ rleURL: rle, previewURL: preview });
  });

  it("keeps prediction output order and ignores unrelated provider metadata", () => {
    const outputs = [{ rle_url: rle, video_url: preview, extra: { provider: "original" } },
      { rle_url: "https://provider.test.invalid/other/rle.json", video_url: "https://provider.test.invalid/other/preview.mp4" }];
    const original = structuredClone(outputs);
    expect(readMiniToolSam3Output(outputs)).toEqual({ rleURL: rle, previewURL: preview });
    expect(outputs).toEqual(original);
  });

  it.each([
    undefined, null, {}, "https://provider.test.invalid/preview.mp4", [],
    ["https://provider.test.invalid/preview.mp4"], [null], [[]],
    [{ video_url: preview }], [{ rle_url: rle }],
    [{ rle_url: rle }, { video_url: preview }],
    [{ video_url: preview }, { rle_url: rle }],
    [{ rle_url: rle, video_url: "" }], [{ rle_url: "", video_url: preview }],
    [{ rle_url: null, video_url: preview }], [{ rle_url: rle, video_url: null }],
    [{ rle_url: 1, video_url: preview }], [{ rle_url: rle, video_url: 1 }],
    [{ rle_url: [rle], video_url: preview }], [{ rle_url: rle, video_url: [preview] }],
  ].map((outputs) => ({ outputs })))("refuses an incomplete original paired output: %j", ({ outputs }) => {
    expect(() => readMiniToolSam3Output(outputs)).toThrow();
  });
});
