// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { resolveTimelineArrangement } from "../arrangement.js";

const tracks = [{ id: "visual-1", kind: "visual" as const, order: 0 }];
const baseClip = {
  id: "30000000-0000-4000-8000-000000000001",
  trackId: "visual-1",
  kind: "video" as const,
  sourceId: "10000000-0000-4000-8000-000000000001",
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 48,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};

/**
 * Give each generated placement a stable, valid clip identity.
 * @returns A complete video clip for arrangement-only tests.
 * @throws {never} Never.
 */
function placement(index: number, startFrame: number, durationFrames: number): typeof baseClip {
  return {
    ...baseClip,
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    startFrame,
    durationFrames,
  };
}

describe("Timeline arrangement from the complete current document", () => {
  it("reads an empty arrangement without creating tracks or clips", () => {
    expect(resolveTimelineArrangement({ tracks, clips: [] })).toEqual({ placements: [], conflicts: [], readyClipIds: [], hasConflicts: false });
  });

  it("accepts adjacent half-open intervals on the same track", () => {
    const next = placement(1, 48, 12);
    expect(resolveTimelineArrangement({ tracks, clips: [baseClip, next] })).toEqual({
      placements: [
        { clipId: baseClip.id, status: "ready", reasons: [] },
        { clipId: next.id, status: "ready", reasons: [] },
      ],
      conflicts: [],
      readyClipIds: [baseClip.id, next.id],
      hasConflicts: false,
    });
  });

  it("marks both overlapping placements and preserves their original intervals", () => {
    const next = placement(1, 47, 12);
    const clips = [baseClip, next];
    const before = structuredClone(clips);
    const result = resolveTimelineArrangement({ tracks, clips });
    expect(result.readyClipIds).toEqual([]);
    expect(result.hasConflicts).toBe(true);
    expect(result.placements).toEqual([
      { clipId: baseClip.id, status: "conflict", reasons: [{ code: "overlap", relatedClipIds: [next.id], startFrame: 47, endFrame: 48 }] },
      { clipId: next.id, status: "conflict", reasons: [{ code: "overlap", relatedClipIds: [baseClip.id], startFrame: 47, endFrame: 48 }] },
    ]);
    expect(result.conflicts).toEqual(result.placements);
    expect(clips).toEqual(before);
  });

  it("keeps a valid placement on another visual track available", () => {
    const otherTrack = { id: "visual-2", kind: "visual" as const, order: 1 };
    const overlaid = { ...placement(1, 0, 48), trackId: otherTrack.id };
    const result = resolveTimelineArrangement({ tracks: [...tracks, otherTrack], clips: [baseClip, overlaid] });
    expect(result.readyClipIds).toEqual([baseClip.id, overlaid.id]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports a missing track without discarding the placement", () => {
    const result = resolveTimelineArrangement({ tracks: [], clips: [baseClip] });
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({ clipId: baseClip.id, status: "conflict", reasons: [{ code: "missing_track" }] });
    expect(result.readyClipIds).toEqual([]);
    expect(result.hasConflicts).toBe(true);
  });

  it("reports an incompatible track for a video placement", () => {
    const result = resolveTimelineArrangement({ tracks: [{ id: "visual-1", kind: "audio", order: 0 }], clips: [baseClip] });
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({ clipId: baseClip.id, status: "conflict", reasons: [{ code: "incompatible_track" }] });
    expect(result.readyClipIds).toEqual([]);
  });

  it.each([
    { startFrame: -1 },
    { startFrame: 0.5 },
    { startFrame: Number.MAX_SAFE_INTEGER, durationFrames: 1 },
    { durationFrames: 0 },
    { durationFrames: -1 },
    { durationFrames: Number.NaN },
  ])("diagnoses merged invalid bounds %j independently from strict DTO validation", (changes) => {
    const result = resolveTimelineArrangement({ tracks, clips: [{ ...baseClip, ...changes }] });
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({ clipId: baseClip.id, status: "conflict", reasons: [{ code: "invalid_range" }] });
    expect(result.readyClipIds).toEqual([]);
  });

  it("recomputes after a conflict is explicitly moved or a placement is removed", () => {
    const conflicting = placement(1, 47, 12);
    expect(resolveTimelineArrangement({ tracks, clips: [baseClip, conflicting] }).hasConflicts).toBe(true);
    const moved = resolveTimelineArrangement({ tracks, clips: [baseClip, { ...conflicting, startFrame: 48 }] });
    expect(moved.readyClipIds).toEqual([baseClip.id, conflicting.id]);
    expect(moved.conflicts).toEqual([]);
    expect(resolveTimelineArrangement({ tracks, clips: [baseClip] }).placements).toEqual([{ clipId: baseClip.id, status: "ready", reasons: [] }]);
  });

  it("has the same classifications and reason order for any arrival order", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ startFrame: fc.integer({ min: 0, max: 120 }), durationFrames: fc.integer({ min: 1, max: 48 }) }), { maxLength: 12 }),
      (ranges) => {
        const clips = ranges.map((range, index) => placement(index, range.startFrame, range.durationFrames));
        const before = structuredClone(clips);
        const forward = resolveTimelineArrangement({ tracks, clips });
        const reverse = resolveTimelineArrangement({ tracks, clips: [...clips].reverse() });
        expect(reverse).toEqual(forward);
        expect(clips).toEqual(before);
        const ready = clips.filter((candidate) => forward.readyClipIds.includes(candidate.id));
        for (let left = 0; left < ready.length; left += 1) {
          for (let right = left + 1; right < ready.length; right += 1) {
            const a = ready[left];
            const b = ready[right];
            if (a === undefined || b === undefined) throw new Error("Generated placement index is missing");
            expect(a.startFrame + a.durationFrames <= b.startFrame || b.startFrame + b.durationFrames <= a.startFrame).toBe(true);
          }
        }
      },
    ));
  });
});
