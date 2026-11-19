// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { planModelWindows } from "../model-windows.js";

/** Presentation frames of a constant-rate clip, as [displayStart, displayEnd) seconds. */
function cfr(count: number, rate: number): { start: number; end: number }[] {
  return Array.from({ length: count }, (_, i) => ({ start: i / rate, end: (i + 1) / rate }));
}

// Execution design §10.5: windows are cut in presentation time, at most 10 s each, overlapping at least 0.625 s, each
// starting after the previous one; a request asks for 10 s, or 5 s when the last window spans at most 5 s.
describe("planModelWindows (execution design §10.5)", () => {
  it("MW01 a clip within 10 s is one window requesting 10 s, or 5 s when it spans at most 5 s", () => {
    expect(planModelWindows(cfr(240, 24))).toEqual([{ span: { start: 0, end: 10 }, duration: 10 }]);
    expect(planModelWindows(cfr(96, 24))).toEqual([{ span: { start: 0, end: 4 }, duration: 5 }]);
  });

  it("MW02 one frame past 10 s takes a second window that overlaps the first by at least 0.625 s", () => {
    const windows = planModelWindows(cfr(241, 24));
    expect(windows).toHaveLength(2);
    expect(windows[0]!.span.end - windows[1]!.span.start).toBeGreaterThanOrEqual(0.625);
    expect(windows[1]!.span.end).toBeCloseTo(241 / 24, 9);
    expect(windows[1]!.duration).toBe(5);
  });

  it("MW03 a single frame of 12 s is split inside the frame", () => {
    const windows = planModelWindows([{ start: 0, end: 12 }]);
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) expect(window.span.end - window.span.start).toBeLessThanOrEqual(10);
    expect(windows.at(-1)!.span.end).toBe(12);
  });

  it("MW04 a frame of 9.8 s followed by another still advances", () => {
    const windows = planModelWindows([{ start: 0, end: 9.8 }, { start: 9.8, end: 19.6 }]);
    expect(windows.at(-1)!.span.end).toBe(19.6);
    windows.slice(1).forEach((window, i) => expect(window.span.start).toBeGreaterThan(windows[i]!.span.start));
  });

  it("MW05 any clip is covered start to end by windows of at most 10 s that overlap and advance", () => {
    fc.assert(fc.property(fc.array(fc.double({ min: 0.01, max: 12, noNaN: true }), { minLength: 1, maxLength: 400 }), (lengths) => {
      let at = 0;
      const frames = lengths.map((length) => { const frame = { start: at, end: at + length }; at += length; return frame; });
      const windows = planModelWindows(frames);
      expect(windows[0]!.span.start).toBe(0);
      expect(windows.at(-1)!.span.end).toBeCloseTo(at, 9);
      windows.forEach((window, i) => {
        expect(window.span.end - window.span.start).toBeLessThanOrEqual(10 + 1e-9);
        expect([5, 10]).toContain(window.duration);
        if (i > 0) {
          expect(window.span.start).toBeGreaterThan(windows[i - 1]!.span.start);
          expect(windows[i - 1]!.span.end - window.span.start).toBeGreaterThanOrEqual(0.625 - 1e-9);
        }
      });
    }));
  });
});
