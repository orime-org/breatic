// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planVideoFrames, type VideoFrameOutput, type VideoFrameRequest } from "../video-plan.js";
import type { VideoPresentationTable } from "../video-presentation-table.js";

// The explicit third-argument contract also loads the old two-argument implementation for a behavioral RED.
const plan: (table: VideoPresentationTable, request: VideoFrameRequest, maxOutputs?: number) => VideoFrameOutput[] = planVideoFrames;
const source: VideoPresentationTable = { schemaVersion: 1, timescale: 10, runs: [{ start: 20, count: 64, step: 10, duration: 10 }] };

// §97 (frames-split §10.6 删除行): the interval-only cases B01, B02, B04, B05 and B08 are deleted with the interval mode
// (4.4.5); every kept mode plans one output, so the budget cases left are one output at budget one and invalid budgets.
describe("S5 configured frame output budget", () => {
  it.each([
    { mode: "first" as const, frameIndex: 0, pts: 2 },
    { mode: "last" as const, frameIndex: 63, pts: 65 },
    { mode: "current" as const, frameIndex: 31, pts: 33 },
  ])("B03 accepts one $mode output at budget one independently from source frame count", ({ mode, frameIndex, pts }) => {
    expect(plan(source, { mode, currentTime: 33.25 }, 1)).toEqual([{ outputIndex: 0, frameIndex, pts }]);
  });
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "B06 rejects invalid configured budget %s after accepting the same valid selection", (budget) => {
      expect(plan(source, { mode: "first" }, 1)).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 2 }]);
      expect(() => plan(source, { mode: "first" }, budget)).toThrow(z.ZodError);
    },
  );
  it("B07 preserves the existing complete plan when no caller budget is supplied", () => {
    expect(plan(source, { mode: "last" })).toEqual([{ outputIndex: 0, frameIndex: 63, pts: 65 }]);
    expect(plan(source, { mode: "last" }, undefined)).toEqual([{ outputIndex: 0, frameIndex: 63, pts: 65 }]);
  });
});
