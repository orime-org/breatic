// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 D15-4 (frames-split §5.4 切块 and 派发 rows, §7.17 转场输出档 row): `planTransitionChunks(timeline,
 * { targetSeconds, frameSeconds })` in shared `video-encode-plan.ts` takes the frame-grid timeline `planVideoTimeline` returns
 * and answers `{ encode, window }` frame windows `{ start, end }` on the output grid: the window chunks partition the overlap
 * window, the encode chunks partition the rest of [0, frameCount), and no chunk's cost exceeds `targetSeconds`; a Cut has no
 * window chunks. Here every frame costs one second (`frameSeconds: () => 1`), so a target of n seconds is n frames (the
 * budget replaced a frame count in §97, a contract change; the cases are unchanged). Where inside a stretch the boundaries fall is not asserted. Read from the mini-tools entry by name so this
 * compiles before the function exists.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type Rational = { numerator: number; denominator: number };
type FrameWindow = { start: number; end: number };
interface PlannedClip { clipId: string; inputId: string; startFrame: number; frameCount: number; inFrame: number; outFrame: number }
interface FrameTimeline { fps: Rational; frameCount: number; clips: PlannedClip[]; window: { startFrame: number; frameCount: number; kind: "fade" | "wipeLeft" | "wipeRight" } | null }
const api = miniTools as unknown as { planTransitionChunks: (timeline: FrameTimeline, budget: { targetSeconds: number; frameSeconds: (frame: number, window: boolean) => number }) => { encode: FrameWindow[]; window: FrameWindow[] } };
/**
 * A budget of n one-second frames.
 * @param count - The largest chunk in frames.
 * @returns The budget.
 */
const frames = (count: number): { targetSeconds: number; frameSeconds: () => number } => ({ targetSeconds: count, frameSeconds: () => 1 });

/**
 * A frame-grid timeline of two clips with an optional overlap window, as D15-3 defines it.
 * @param first - The first clip's frame count.
 * @param second - The second clip's frame count.
 * @param overlap - The window's frame count, 0 for a Cut.
 * @returns The timeline.
 */
function timeline(first: number, second: number, overlap: number): FrameTimeline {
  const start = first - overlap;
  return {
    fps: { numerator: 30, denominator: 1 }, frameCount: start + second,
    window: overlap === 0 ? null : { startFrame: start, frameCount: overlap, kind: "fade" },
    clips: [
      { clipId: "30000000-0000-4000-8000-000000000001", inputId: "40000000-0000-4000-8000-000000000001", startFrame: 0, frameCount: first, inFrame: 30, outFrame: 30 + first },
      { clipId: "30000000-0000-4000-8000-000000000002", inputId: "40000000-0000-4000-8000-000000000002", startFrame: overlap === 0 ? first : start, frameCount: second, inFrame: 60, outFrame: 60 + second },
    ],
  };
}

/**
 * Whether windows run end to end over [from, to) in order, each non-empty and within the target.
 * @param windows - The windows.
 * @param from - The first frame.
 * @param to - The end frame.
 * @param target - The largest chunk.
 * @returns Whether they partition the range.
 */
function partitions(windows: readonly FrameWindow[], from: number, to: number, target: number): boolean {
  let cursor = from;
  for (const chunk of windows) {
    if (chunk.start !== cursor || chunk.end <= chunk.start || chunk.end - chunk.start > target) return false;
    cursor = chunk.end;
  }
  return cursor === to;
}

describe("transition chunks on the output frame grid (§97 D15-4)", () => {
  it("TC01 a fade: the window chunks cover the window, the encode chunks the frames before and after it", () => {
    const plan = api.planTransitionChunks(timeline(90, 120, 15), frames(50));
    expect(partitions(plan.window, 75, 90, 50)).toBe(true);
    expect(partitions(plan.encode.filter((chunk) => chunk.end <= 75), 0, 75, 50)).toBe(true);
    expect(partitions(plan.encode.filter((chunk) => chunk.start >= 90), 90, 195, 50)).toBe(true);
    expect(plan.encode.every((chunk) => chunk.end <= 75 || chunk.start >= 90)).toBe(true);
  });

  it("TC02 a window longer than the target is split into several window chunks", () => {
    const plan = api.planTransitionChunks(timeline(90, 120, 40), frames(16));
    expect(plan.window.length).toBeGreaterThanOrEqual(3);
    expect(partitions(plan.window, 50, 90, 16)).toBe(true);
  });

  it("TC03 a Cut has no window chunks and the encode chunks cover the whole timeline", () => {
    const plan = api.planTransitionChunks(timeline(90, 120, 0), frames(50));
    expect(plan.window).toEqual([]);
    expect(partitions(plan.encode, 0, 210, 50)).toBe(true);
  });

  it("TC04 for any timeline and target, window and encode chunks together partition [0, frameCount)", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 400 }), fc.integer({ min: 2, max: 400 }), fc.double({ min: 0, max: 0.5, noNaN: true }), fc.integer({ min: 1, max: 120 }),
      (first, second, share, target) => {
        const overlap = Math.floor(Math.min(first, second) * share);
        const plan = api.planTransitionChunks(timeline(first, second, overlap), frames(target));
        const all = [...plan.encode, ...plan.window].sort((a, b) => a.start - b.start);
        expect(partitions(all, 0, first - overlap + second, target)).toBe(true);
        if (overlap === 0) expect(plan.window).toEqual([]);
        else expect(partitions(plan.window, first - overlap, first, target)).toBe(true);
      }));
  });
});
