// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planVideoFrames, type VideoFrameOutput, type VideoFrameRequest, type VideoPlanGrid } from "../video-plan.js";

// The explicit third-argument contract also loads the old two-argument implementation for a behavioral RED.
const plan: (grid: VideoPlanGrid, request: VideoFrameRequest, maxOutputs?: number) => VideoFrameOutput[] = planVideoFrames;
// frames-split §10.7 抽帧 row: frames are planned on the selected P's grid, by grid frame number.
const source: VideoPlanGrid = { fps: { numerator: 1, denominator: 1 }, frameCount: 64 };

// §97 (frames-split §10.6 删除行): the interval-only cases B01, B02, B04, B05 and B08 are deleted with the interval mode
// (4.4.5); every kept mode plans one output, so the budget cases left are one output at budget one and invalid budgets.
describe("S5 configured frame output budget", () => {
  it.each([
    { mode: "first" as const, frameIndex: 0 },
    { mode: "last" as const, frameIndex: 63 },
    { mode: "current" as const, frameIndex: 31 },
  ])("B03 accepts one $mode output at budget one independently from source frame count", ({ mode, frameIndex }) => {
    expect(plan(source, { mode, frameIndex: 31 }, 1)).toEqual([{ outputIndex: 0, frameIndex }]);
  });
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "B06 rejects invalid configured budget %s after accepting the same valid selection", (budget) => {
      expect(plan(source, { mode: "first" }, 1)).toEqual([{ outputIndex: 0, frameIndex: 0 }]);
      expect(() => plan(source, { mode: "first" }, budget)).toThrow(z.ZodError);
    },
  );
  it("B07 preserves the existing complete plan when no caller budget is supplied", () => {
    expect(plan(source, { mode: "last" })).toEqual([{ outputIndex: 0, frameIndex: 63 }]);
    expect(plan(source, { mode: "last" }, undefined)).toEqual([{ outputIndex: 0, frameIndex: 63 }]);
  });
});
