// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineTrack } from "@shared/timeline/schema.js";

/** The placement fields needed to diagnose a merged collaborative layout. */
export interface TimelineArrangementClip { id: string; trackId: string; kind: string; startFrame: number; durationFrames: number }

/** One stable diagnostic, retained alongside the unmodified placement. */
export interface TimelineArrangementReason {
  code: "overlap" | "missing_track" | "incompatible_track" | "invalid_range";
  relatedClipIds: string[];
  startFrame: number | null;
  endFrame: number | null;
}

/** One current clip's derived readiness. */
export interface TimelinePlacement { clipId: string; status: "ready" | "conflict"; reasons: TimelineArrangementReason[] }

/** A deterministic view of the complete current arrangement. */
export interface TimelineArrangement { placements: TimelinePlacement[]; conflicts: TimelinePlacement[]; readyClipIds: string[]; hasConflicts: boolean }

/**
 * Diagnose the complete merged layout without moving or removing clips.
 * @param input - The complete current arrangement.
 * @param input.tracks - Current track identities and kinds.
 * @param input.clips - Current raw placement bounds.
 * @returns Stable readiness and conflict classifications.
 * @throws {never} Never.
 */
export function resolveTimelineArrangement(input: { tracks: readonly TimelineTrack[]; clips: readonly TimelineArrangementClip[] }): TimelineArrangement {
  const tracks = new Map(input.tracks.map((track) => [track.id, track]));
  const records = [...input.clips].sort((a, b) => compareIds(a.id, b.id)).map((clip) => {
    const endFrame = clip.startFrame + clip.durationFrames;
    const reasons: TimelineArrangementReason[] = [];
    const detail = { relatedClipIds: [], startFrame: displayFrame(clip.startFrame), endFrame: displayFrame(endFrame) };
    const track = tracks.get(clip.trackId);
    if (!track) reasons.push({ code: "missing_track", ...detail });
    else if (track.kind !== (clip.kind === "audio" ? "audio" : "visual")) reasons.push({ code: "incompatible_track", ...detail });
    if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0
      || !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1
      || !Number.isSafeInteger(endFrame)) reasons.push({ code: "invalid_range", ...detail });
    return { clip, endFrame, reasons };
  });

  for (let left = 0; left < records.length; left += 1) {
    const a = records[left];
    if (!a || a.reasons.some((reason) => reason.code !== "overlap")) continue;
    for (let right = left + 1; right < records.length; right += 1) {
      const b = records[right];
      if (!b || b.reasons.some((reason) => reason.code !== "overlap") || a.clip.trackId !== b.clip.trackId
        || a.clip.startFrame >= b.endFrame || b.clip.startFrame >= a.endFrame) continue;
      const startFrame = Math.max(a.clip.startFrame, b.clip.startFrame);
      const endFrame = Math.min(a.endFrame, b.endFrame);
      a.reasons.push({ code: "overlap", relatedClipIds: [b.clip.id], startFrame, endFrame });
      b.reasons.push({ code: "overlap", relatedClipIds: [a.clip.id], startFrame, endFrame });
    }
  }

  const placements: TimelinePlacement[] = records.map(({ clip, reasons }) => ({
    clipId: clip.id,
    status: reasons.length > 0 ? "conflict" : "ready",
    reasons: reasons.sort((a, b) => compareIds(a.code, b.code)
      || compareIds(a.relatedClipIds[0] ?? "", b.relatedClipIds[0] ?? "")
      || (a.startFrame ?? 0) - (b.startFrame ?? 0) || (a.endFrame ?? 0) - (b.endFrame ?? 0)),
  }));
  const conflicts = placements.filter((placement) => placement.status === "conflict");
  return { placements, conflicts, readyClipIds: placements.filter((placement) => placement.status === "ready").map((placement) => placement.clipId), hasConflicts: conflicts.length > 0 };
}

/**
 * Compare identities in code-unit order, independent of a client's locale.
 * @param left - The first identity.
 * @param right - The second identity.
 * @returns Their stable order.
 * @throws {never} Never.
 */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Keep an invalid finite bound available for the conflict's visible diagnosis.
 * @param frame - The raw frame bound.
 * @returns The bound, or null when it cannot be displayed as a number.
 * @throws {never} Never.
 */
function displayFrame(frame: number): number | null {
  return Number.isFinite(frame) ? frame : null;
}
