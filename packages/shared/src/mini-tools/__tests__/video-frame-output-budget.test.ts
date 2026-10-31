// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planVideoFrames, type VideoFrameOutput, type VideoFrameRequest } from "../video-plan.js";
import type { VideoPresentationTable } from "../video-presentation-table.js";

// The explicit third-argument contract also loads the old two-argument implementation for a behavioral RED.
const plan: (table: VideoPresentationTable, request: VideoFrameRequest, maxOutputs?: number) => VideoFrameOutput[] = planVideoFrames;
const source: VideoPresentationTable = { schemaVersion: 1, timescale: 10, runs: [{ start: 20, count: 64, step: 10, duration: 10 }] };
const all = Array.from({ length: 64 }, (_, frameIndex) => ({ outputIndex: frameIndex, frameIndex, pts: frameIndex + 2 }));

describe("S5 configured frame output budget", () => {
  it("B01 refuses a 64-output interval plan exceeding a configured four-output budget", () => {
    expect(plan(source, { mode: "interval", interval: 1 }, 64)).toEqual(all);
    expect(() => plan(source, { mode: "interval", interval: 1 }, 4)).toThrow(RangeError);
  });
  it.each([64, Number.MAX_SAFE_INTEGER])("B02 accepts the complete plan at a valid budget of %s without truncation", (budget) => {
    expect(plan(source, { mode: "interval", interval: 1 }, budget)).toEqual(all);
  });
  it.each([
    { mode: "first" as const, frameIndex: 0, pts: 2 },
    { mode: "last" as const, frameIndex: 63, pts: 65 },
    { mode: "current" as const, frameIndex: 31, pts: 33 },
  ])("B03 accepts one $mode output at budget one independently from source frame count", ({ mode, frameIndex, pts }) => {
    expect(plan(source, { mode, currentTime: 33.25 }, 1)).toEqual([{ outputIndex: 0, frameIndex, pts }]);
  });
  it("B04 budgets distinct output frames rather than repeated interval samples", () => {
    const table: VideoPresentationTable = { schemaVersion: 1, timescale: 8, runs: [{ start: 16, count: 4, step: 8, duration: 8 }] };
    const expected = all.slice(0, 4);
    expect(plan(table, { mode: "interval", interval: 0.125 }, 4)).toEqual(expected);
    expect(() => plan(table, { mode: "interval", interval: 0.125 }, 3)).toThrow(RangeError);
  });
  it("B05 also enforces the budget when interval division exceeds safe sample counting", () => {
    expect(plan(source, { mode: "interval", interval: Number.MIN_VALUE }, 64)).toEqual(all);
    expect(() => plan(source, { mode: "interval", interval: Number.MIN_VALUE }, 63)).toThrow(RangeError);
  });
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "B06 rejects invalid configured budget %s after accepting the same valid selection", (budget) => {
      expect(plan(source, { mode: "first" }, 1)).toEqual([{ outputIndex: 0, frameIndex: 0, pts: 2 }]);
      expect(() => plan(source, { mode: "first" }, budget)).toThrow(z.ZodError);
    },
  );
  it("B07 preserves the existing complete plan when no caller budget is supplied", () => {
    expect(plan(source, { mode: "interval", interval: 1 })).toEqual(all);
    expect(plan(source, { mode: "interval", interval: 1 }, undefined)).toEqual(all);
  });
  it("B08 rejects every generated undersized budget while preserving every exact-cap plan", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 64 }), fc.integer({ min: 1, max: 63 }), (count, requestedBudget) => {
      const table: VideoPresentationTable = { schemaVersion: 1, timescale: 10, runs: [{ start: 20, count, step: 10, duration: 10 }] };
      const budget = Math.min(count - 1, requestedBudget);
      expect(plan(table, { mode: "interval", interval: 1 }, count)).toEqual(all.slice(0, count));
      expect(() => plan(table, { mode: "interval", interval: 1 }, budget)).toThrow(RangeError);
    }), { seed: 130605, numRuns: 32 });
  });
});
