// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineDocumentV1, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';

import { compareTimelineIds } from '@web/data/yjs/timeline-order';
import { timelineClipIntervalValid, validateTimelineRange } from '@web/data/yjs/timeline-time';

/** One stable diagnostic, retained alongside the unmodified placement. */
export interface TimelineArrangementReason {
  code: 'overlap' | 'missing_track' | 'incompatible_track' | 'invalid_range' | 'missing_source';
  relatedClipIds: string[];
  startFrame: number | null;
  endFrame: number | null;
}

/** One current clip's derived readiness. */
export interface TimelinePlacement { clipId: string; status: 'ready' | 'conflict'; reasons: TimelineArrangementReason[] }

/** A deterministic view of the complete current arrangement. */
export interface TimelineArrangement { placements: TimelinePlacement[]; conflicts: TimelinePlacement[]; readyClipIds: string[]; hasConflicts: boolean }

/**
 * Diagnose the complete merged layout without moving or removing clips.
 * @param document - The current document; a clip outside its source is invalid_range, one whose source is gone is missing_source.
 * @returns Stable readiness and conflict classifications.
 * @throws {never} Never.
 */
export function resolveTimelineArrangement(document: TimelineDocumentV1): TimelineArrangement {
  const tracks = new Map(Object.values(document.tracks).map((track) => [track.id, track]));
  const records = Object.values(document.clips).sort((a, b) => compareTimelineIds(a.id, b.id)).map((clip) => {
    const endFrame = clip.startFrame + clip.durationFrames;
    const reasons: TimelineArrangementReason[] = [];
    const detail = { relatedClipIds: [], startFrame: displayFrame(clip.startFrame), endFrame: displayFrame(endFrame) };
    const track = tracks.get(clip.trackId);
    if (!track) reasons.push({ code: 'missing_track', ...detail });
    else if (track.kind !== 'visual') reasons.push({ code: 'incompatible_track', ...detail });
    const source = document.sources[clip.sourceId];
    if (source === undefined) reasons.push({ code: 'missing_source', ...detail });
    if (!timelineClipIntervalValid(clip) || outsideSource(clip, source, document)) reasons.push({ code: 'invalid_range', ...detail });
    return { clip, endFrame, reasons };
  });

  for (let left = 0; left < records.length; left += 1) {
    const a = records[left];
    if (!a || a.reasons.some((reason) => reason.code !== 'overlap')) continue;
    for (let right = left + 1; right < records.length; right += 1) {
      const b = records[right];
      if (!b || b.reasons.some((reason) => reason.code !== 'overlap') || a.clip.trackId !== b.clip.trackId
        || a.clip.startFrame >= b.endFrame || b.clip.startFrame >= a.endFrame) continue;
      const startFrame = Math.max(a.clip.startFrame, b.clip.startFrame);
      const endFrame = Math.min(a.endFrame, b.endFrame);
      a.reasons.push({ code: 'overlap', relatedClipIds: [b.clip.id], startFrame, endFrame });
      b.reasons.push({ code: 'overlap', relatedClipIds: [a.clip.id], startFrame, endFrame });
    }
  }

  const placements: TimelinePlacement[] = records.map(({ clip, reasons }) => ({
    clipId: clip.id,
    status: reasons.length > 0 ? 'conflict' : 'ready',
    reasons: reasons.sort((a, b) => compareTimelineIds(a.code, b.code)
      || compareTimelineIds(a.relatedClipIds[0] ?? '', b.relatedClipIds[0] ?? '')
      || (a.startFrame ?? 0) - (b.startFrame ?? 0) || (a.endFrame ?? 0) - (b.endFrame ?? 0)),
  }));
  const conflicts = placements.filter((placement) => placement.status === 'conflict');
  return { placements, conflicts, readyClipIds: placements.filter((placement) => placement.status === 'ready').map((placement) => placement.clipId), hasConflicts: conflicts.length > 0 };
}

/**
 * Whether a clip samples outside its source.
 * @param clip - The placement.
 * @param source - Its source, when the document has it.
 * @param document - The document, for its frame rate.
 * @returns True only when the source is present and the range is invalid for it.
 * @throws {never} Never.
 */
function outsideSource(clip: TimelineVideoClip, source: TimelineVideoSource | undefined, document: TimelineDocumentV1): boolean {
  return source !== undefined && !validateTimelineRange(clip, source, document.settings.fps).valid;
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
