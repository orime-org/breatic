// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import {
  durationToFrames, type TimelineClip, type TimelineDocumentV1, type TimelineRate, type TimelineUploadClip, type TimelineVideoSource,
  type TimelineWebResolution,
} from '@breatic/shared';

import { compareTimelineIds } from '@web/data/yjs/timeline-order';
import { timelineClipIntervalValid, validateTimelineRange, type TimelineSourceExtent } from '@web/data/yjs/timeline-time';

/** A resolution that knows no reference. */
export const EMPTY_TIMELINE_WEB_RESOLUTION: TimelineWebResolution = Object.freeze({ sources: Object.freeze({}), executions: Object.freeze({}) });

/**
 * The source version a web-animation copy shows now: its bound result, or the result of the execution it waits for
 * once that has succeeded.
 * @param web - The resolution.
 * @param clip - The copy.
 * @returns The source version id, or null while there is none to show.
 * @throws {never} Never.
 */
export function timelineWebSourceOf(web: TimelineWebResolution, clip: Extract<TimelineClip, { kind: 'web-animation' }>): string | null {
  const { baseSourceResultId, operationId } = clip.contentBinding;
  if (baseSourceResultId !== null) return baseSourceResultId;
  const execution = operationId === null ? undefined : web.executions[operationId];
  return execution?.status === 'succeeded' ? execution.resultSourceVersionId : null;
}

/**
 * The extent an upload placeholder is measured against: the file the browser read, conformed like a registered video.
 * @param fps - The document frame rate.
 * @param clip - The placeholder.
 * @returns The extent, or undefined when the duration is too long to count in frames.
 * @throws {never} Never.
 */
export function timelineUploadExtent(fps: TimelineRate, clip: TimelineUploadClip): TimelineSourceExtent | undefined {
  try {
    const { durationSeconds } = clip.upload;
    return { timebase: fps, extentFrames: durationToFrames(durationSeconds, fps), durationSeconds: String(durationSeconds) };
  } catch {
    // A duration whose frame count is not a safe integer cannot be measured, like a missing source.
    return undefined;
  }
}

/**
 * The extent a clip's frames are measured against (design §3.2): a video's registered source; an upload placeholder's
 * local file; a web copy's bound source version; a placeholder's result once its execution succeeded, otherwise the
 * length its execution accepted.
 * @param document - The document, for video sources.
 * @param web - The resolution of web references.
 * @param clip - The clip.
 * @returns The extent, or undefined when the source is missing or the reference is unresolved.
 * @throws {never} Never.
 */
export function resolveTimelineClipExtent(document: TimelineDocumentV1, web: TimelineWebResolution, clip: TimelineClip): TimelineSourceExtent | undefined {
  if (clip.kind === 'video') return document.sources[clip.sourceId];
  if (clip.kind === 'upload') return timelineUploadExtent(document.settings.fps, clip);
  const sourceId = timelineWebSourceOf(web, clip);
  const source = sourceId === null ? undefined : web.sources[sourceId];
  if (source !== undefined) return { timebase: source.fps, extentFrames: source.durationFrames };
  const execution = clip.contentBinding.baseSourceResultId === null && clip.contentBinding.operationId !== null
    ? web.executions[clip.contentBinding.operationId] : undefined;
  return execution === undefined ? undefined : { timebase: execution.fps, extentFrames: execution.acceptedDurationFrames };
}

/** One stable diagnostic, retained alongside the unmodified placement. */
export interface TimelineArrangementReason {
  code: 'overlap' | 'missing_track' | 'incompatible_track' | 'invalid_range' | 'missing_source' | 'source_unresolved';
  relatedClipIds: string[];
  startFrame: number | null;
  endFrame: number | null;
}

/** One current clip's derived readiness. */
export interface TimelinePlacement { clipId: string; status: 'ready' | 'conflict'; reasons: TimelineArrangementReason[] }

/** A deterministic view of the complete current arrangement. */
export interface TimelineArrangement { placements: TimelinePlacement[]; conflicts: TimelinePlacement[]; readyClipIds: string[]; hasConflicts: boolean }

/**
 * The registered video a clip shows, for reading its asset; web-animation and upload clips have none.
 * @param sources - The document's sources.
 * @param clip - The placement.
 * @returns Its source, or undefined when it has none.
 * @throws {never} Never.
 */
export function timelineClipSource(sources: Record<string, TimelineVideoSource>, clip: TimelineClip): TimelineVideoSource | undefined {
  return clip.kind === 'video' ? sources[clip.sourceId] : undefined;
}

/**
 * Diagnose the complete merged layout without moving or removing clips.
 * @param document - The current document; a clip outside its source is invalid_range, one whose video is gone is
 *   missing_source, and a web copy whose reference the resolution does not know is source_unresolved.
 * @param web - The resolution of the document's web references.
 * @returns Stable readiness and conflict classifications.
 * @throws {never} Never.
 */
export function resolveTimelineArrangement(document: TimelineDocumentV1, web: TimelineWebResolution = EMPTY_TIMELINE_WEB_RESOLUTION): TimelineArrangement {
  const tracks = new Map(Object.values(document.tracks).map((track) => [track.id, track]));
  const records = Object.values(document.clips).sort((a, b) => compareTimelineIds(a.id, b.id)).map((clip) => {
    const endFrame = clip.startFrame + clip.durationFrames;
    const reasons: TimelineArrangementReason[] = [];
    const detail = { relatedClipIds: [], startFrame: displayFrame(clip.startFrame), endFrame: displayFrame(endFrame) };
    const track = tracks.get(clip.trackId);
    if (!track) reasons.push({ code: 'missing_track', ...detail });
    else if (track.kind !== 'visual') reasons.push({ code: 'incompatible_track', ...detail });
    const source = resolveTimelineClipExtent(document, web, clip);
    if (source === undefined) reasons.push({ code: clip.kind === 'web-animation' ? 'source_unresolved' : 'missing_source', ...detail });
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
function outsideSource(clip: TimelineClip, source: TimelineSourceExtent | undefined, document: TimelineDocumentV1): boolean {
  return source !== undefined && !validateTimelineRange(clip, source, document.settings.fps);
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
