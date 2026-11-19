// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { clipJobWindows, trackingClips } from "../tracking-clips.js";

// Execution design §10.2: the hosted SAM3 takes its prompt on frame 0 only (probe sam3-mid-anchor, code 1405), so a
// range [s, e) anchored at a is tracked forward from a and, when a > s, reversed from a back to s.
describe("trackingClips (execution design §10.2)", () => {
  it("TC01 an anchor on the first frame tracks one forward clip over the whole range", () => {
    expect(trackingClips({ start: 0, end: 90 }, 0)).toEqual({ forward: { start: 0, end: 90 }, reverse: null });
  });

  it("TC02 an anchor in the middle tracks forward from it and reversed back to the first frame", () => {
    expect(trackingClips({ start: 0, end: 90 }, 45)).toEqual({ forward: { start: 45, end: 90 }, reverse: { start: 0, end: 46 } });
  });

  it("TC03 an anchor on the last frame tracks only the reversed clip", () => {
    expect(trackingClips({ start: 10, end: 90 }, 89)).toEqual({ forward: null, reverse: { start: 10, end: 90 } });
  });

  it("TC04 a one-frame range tracks one forward clip", () => {
    expect(trackingClips({ start: 7, end: 8 }, 7)).toEqual({ forward: { start: 7, end: 8 }, reverse: null });
  });

  it("TC05 refuses an anchor outside the range", () => {
    expect(() => trackingClips({ start: 0, end: 90 }, 90)).toThrow(RangeError);
    expect(() => trackingClips({ start: 10, end: 90 }, 9)).toThrow(RangeError);
  });

  // The reverse filter holds every decoded frame of its window, 8-bit 4:2:0 at the prepared size: a 3840x2160 frame is
  // 12441600 bytes, so a 2 GiB buffer holds 172 of them and the 1801 frames up to an anchor at 60 s of 30 fps are 11 jobs.
  it("TC06 a reversed clip over the reverse buffer is prepared in chunks of the frames the buffer holds; a forward clip in one job", () => {
    const uhd = { width: 3840, height: 2160 };
    const windows = clipJobWindows({ start: 0, end: 1801 }, "reverse", uhd, 2_147_483_648);
    expect(windows).toHaveLength(11);
    expect(windows[0]).toEqual({ start: 0, end: 172 });
    expect(windows.at(-1)).toEqual({ start: 1720, end: 1801 });
    for (let at = 1; at < windows.length; at += 1) expect(windows[at]!.start).toBe(windows[at - 1]!.end);
    expect(clipJobWindows({ start: 1800, end: 2700 }, "forward", uhd, 2_147_483_648)).toEqual([{ start: 1800, end: 2700 }]);
    expect(clipJobWindows({ start: 0, end: 172 }, "reverse", uhd, 2_147_483_648)).toEqual([{ start: 0, end: 172 }]);
  });
});

// Execution design §10.2 on the frame grid (frames-split §7.16 区间 row): the erase anchor's grid frame must lie in the
// tracking range of grid frames, checked by the panel and analysis admission alike.
describe("anchorInTrackingRange (execution design §10.2)", () => {
  it("TC08 holds for start ≤ anchor.frameIndex < end only", async () => {
    const { anchorInTrackingRange } = await import("../tracking-clips.js");
    const range = { start: 25, end: 75 };
    expect(anchorInTrackingRange(range, { frameIndex: 25 })).toBe(true);
    expect(anchorInTrackingRange(range, { frameIndex: 74 })).toBe(true);
    expect(anchorInTrackingRange(range, { frameIndex: 75 })).toBe(false);
    expect(anchorInTrackingRange(range, { frameIndex: 24 })).toBe(false);
  });
});

// Execution design §10.2, §10.4: the panel and admission refuse an erase selection by one check, so they cannot disagree.
describe("eraseRangeCheck (execution design §10.2, §10.4)", () => {
  // 25 fps for 10 s.
  const GRID = { fps: { numerator: 25, denominator: 1 }, frameCount: 250 };
  const LIMITS = { minSeconds: 1, maxSeconds: 5, maxGridFps: 25 };

  it("TC09 names the anchor first, then the range, and returns the grid of an allowed selection", async () => {
    const { eraseRangeCheck } = await import("../tracking-clips.js");
    expect(eraseRangeCheck(GRID, { start: 50, end: 100 }, { frameIndex: 125 }, { minSeconds: 1, maxSeconds: 1.5, maxGridFps: 25 })).toEqual({ refusal: "anchor" });
    expect(eraseRangeCheck(GRID, { start: 50, end: 225 }, { frameIndex: 75 }, LIMITS)).toEqual({ refusal: "range" });
    expect(eraseRangeCheck(GRID, { start: 50, end: 51 }, { frameIndex: 50 }, LIMITS)).toEqual({ refusal: "range" });
    expect(eraseRangeCheck(GRID, { start: 50, end: 100 }, { frameIndex: 75 }, LIMITS)).toEqual({ refusal: null, first: 50, count: 50, grid: { mode: "frames", rate: 25, frameCount: 50 } });
  });
});
