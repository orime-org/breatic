// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { joinTrackingClips, trackingClips } from "../tracking-clips.js";

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

  it("TC06 joining covers the whole range once, in order, with the anchor frame taken from the forward clip", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 50 }), fc.integer({ min: 1, max: 60 }), fc.nat(), (start, length, at) => {
      const range = { start, end: start + length };
      const anchor = start + (at % length);
      const clips = trackingClips(range, anchor);
      const forward = clips.forward === null ? null : Array.from({ length: clips.forward.end - clips.forward.start }, (_, i) => `f${clips.forward!.start + i}`);
      // A reversed clip's frame 0 is the anchor and its last frame is the range start.
      const reverse = clips.reverse === null ? null : Array.from({ length: clips.reverse.end - clips.reverse.start }, (_, i) => `r${clips.reverse!.end - 1 - i}`);
      const joined = joinTrackingClips(clips, forward, reverse);
      expect(joined).toHaveLength(length);
      expect(joined.map((frame) => Number(frame.slice(1)))).toEqual(Array.from({ length }, (_, i) => start + i));
      if (clips.forward !== null) expect(joined[anchor - start]).toBe(`f${anchor}`);
    }));
  });

  it("TC07 joining refuses a segment whose frame count differs from its clip", () => {
    const clips = trackingClips({ start: 0, end: 4 }, 2);
    expect(() => joinTrackingClips(clips, ["a", "b"], ["c", "d"])).toThrow(RangeError);
  });
});

// Execution design §10.2: the erase anchor must lie in the tracking range, checked by the panel and analysis admission alike.
describe("anchorInTrackingRange (execution design §10.2)", () => {
  it("TC08 holds for start ≤ anchor.pts < end only", async () => {
    const { anchorInTrackingRange } = await import("../tracking-clips.js");
    const range = { start: 1, end: 3 };
    expect(anchorInTrackingRange(range, { frameIndex: 25, pts: 1 })).toBe(true);
    expect(anchorInTrackingRange(range, { frameIndex: 74, pts: 2.96 })).toBe(true);
    expect(anchorInTrackingRange(range, { frameIndex: 75, pts: 3 })).toBe(false);
    expect(anchorInTrackingRange(range, { frameIndex: 24, pts: 0.96 })).toBe(false);
  });
});
