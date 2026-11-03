// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1 } from '@breatic/shared';
import { timelineInsertionIndex, type TimelineEditCommand, type TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { orderedTimelineClips } from '@web/data/yjs/timeline-order';
import { timelineHeadRoom, timelineSourceRoom, timelineTrimHead } from '@web/data/yjs/timeline-time';
import { snapTimelineEdges, timelineSnapTargets, TIMELINE_SNAP_PX } from '@web/spaces/timeline/timeline-snap';

/** What a pointer drag on a clip changes. */
export type TimelineGestureMode = 'move' | 'trim-start' | 'trim-end';

/** Where a drag would put the clip if released now; `trackId` null is the new-track zone. */
export interface TimelineGesturePreview {
  clipId: string;
  trackId: string | null;
  startFrame: number;
  sourceInFrame: number;
  durationFrames: number;
  snapFrame: number | null;
}

/** View facts a preview depends on. */
export interface TimelineGestureOptions { snap: boolean; pixelsPerFrame: number; playhead: number; magnet?: boolean }

/**
 * Clamp a value into an inclusive range.
 * @param value - The value.
 * @param min - The lower bound.
 * @param max - The upper bound.
 * @returns The clamped value.
 * @throws {never} Never.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Where the insertion marker sits while a clip is dragged along the magnetic main track: the gap in the current
 * layout before which the planner inserts it.
 * @param document - The current document.
 * @param clipId - The dragged clip.
 * @param dropFrame - The pointer's drop frame.
 * @returns The marker frame.
 * @throws {never} Never.
 */
export function timelineInsertMarkerFrame(document: TimelineDocumentV1, clipId: string, dropFrame: number): number {
  const sequence = orderedTimelineClips(document.clips, TIMELINE_MAIN_TRACK_ID).filter((clip) => clip.id !== clipId);
  const before = sequence[timelineInsertionIndex(sequence, dropFrame) - 1];
  return before === undefined ? 0 : before.startFrame + before.durationFrames;
}

/**
 * Preview a drag of `deltaFrames` frames on one clip.
 * @param document - The current document.
 * @param clipId - The dragged clip.
 * @param mode - Move, or trim one edge.
 * @param deltaFrames - The pointer travel in frames.
 * @param hover - The hovered track id, 'new' for the new-track zone, or null to keep the track.
 * @param options - Snapping, zoom and playhead.
 * @returns The preview, or null when the clip no longer exists.
 * @throws {never} Never.
 */
export function previewTimelineGesture(
  document: TimelineDocumentV1, clipId: string, mode: TimelineGestureMode, deltaFrames: number,
  hover: string | 'new' | null, options: TimelineGestureOptions,
): TimelineGesturePreview | null {
  const clip = document.clips[clipId];
  if (clip === undefined) return null;
  const targets = options.snap ? timelineSnapTargets(document, clipId, options.playhead) : [];
  /**
   * Snap the given edges to the targets at the current zoom.
   * @param edges - The moving edges.
   * @returns The snap, or null.
   * @throws {never} Never.
   */
  function snapTo(edges: number[]): { shift: number; frame: number } | null {
    return snapTimelineEdges(edges, targets, options.pixelsPerFrame, TIMELINE_SNAP_PX);
  }
  const base = { clipId, trackId: clip.trackId, startFrame: clip.startFrame, sourceInFrame: clip.sourceInFrame, durationFrames: clip.durationFrames, snapFrame: null };
  const source = document.sources[clip.sourceId];
  const fps = document.settings.fps;
  const packed = options.magnet === true;

  if (mode === 'move') {
    const trackId = hover === 'new' ? null : hover !== null && document.tracks[hover] !== undefined ? hover : clip.trackId;
    let startFrame = Math.max(0, clip.startFrame + deltaFrames);
    let snapFrame: number | null = null;
    const snapped = snapTo([startFrame, startFrame + clip.durationFrames]);
    if (snapped !== null && startFrame + snapped.shift >= 0) {
      startFrame += snapped.shift;
      snapFrame = snapped.frame;
    }
    return { ...base, trackId, startFrame, snapFrame };
  }

  if (mode === 'trim-start') {
    // On the magnetic main track the planner keeps the clip packed, so only the source in-point bounds the head.
    const keepsStart = packed && clip.trackId === TIMELINE_MAIN_TRACK_ID;
    if (source === undefined) {
      // Without its source the in-point moves frame for frame; the planner refuses the edit and says why.
      const shift = clamp(deltaFrames, -(keepsStart ? clip.sourceInFrame : Math.min(clip.sourceInFrame, clip.startFrame)), clip.durationFrames - 1);
      if (shift === 0) return base;
      return { ...base, startFrame: clip.startFrame + shift < 0 ? clip.startFrame : clip.startFrame + shift, sourceInFrame: clip.sourceInFrame + shift, durationFrames: clip.durationFrames - shift };
    }
    const headRoom = timelineHeadRoom(clip, source, fps);
    const lowest = -(keepsStart ? headRoom : Math.min(headRoom, clip.startFrame));
    const highest = clip.durationFrames - 1;
    let shift = clamp(deltaFrames, lowest, highest);
    let snapFrame: number | null = null;
    const snapped = snapTo([clip.startFrame + shift]);
    if (snapped !== null && shift + snapped.shift >= lowest && shift + snapped.shift <= highest) {
      shift += snapped.shift;
      snapFrame = snapped.frame;
    }
    const target = shift;
    // A head that lands between source frames moves back toward its start to the nearest whole one.
    let sourceInFrame = timelineTrimHead(clip, source, fps, shift);
    while (sourceInFrame === null && shift !== 0) {
      shift -= Math.sign(shift);
      sourceInFrame = timelineTrimHead(clip, source, fps, shift);
    }
    if (sourceInFrame === null || shift === 0) return base;
    // A head pulled past frame 0 on the magnetic main track previews the committed result: the clip keeps its slot.
    return { ...base, startFrame: clip.startFrame + shift < 0 ? clip.startFrame : clip.startFrame + shift, sourceInFrame, durationFrames: clip.durationFrames - shift, snapFrame: shift === target ? snapFrame : null };
  }

  const longest = source === undefined ? Number.MAX_SAFE_INTEGER - clip.startFrame : Math.max(1, timelineSourceRoom(clip, source, fps));
  let durationFrames = clamp(clip.durationFrames + deltaFrames, 1, longest);
  let snapFrame: number | null = null;
  const snapped = snapTo([clip.startFrame + durationFrames]);
  if (snapped !== null && durationFrames + snapped.shift >= 1 && durationFrames + snapped.shift <= longest) {
    durationFrames += snapped.shift;
    snapFrame = snapped.frame;
  }
  return { ...base, durationFrames, snapFrame };
}

/**
 * The command a release commits.
 * @param document - The document at release.
 * @param preview - The last preview.
 * @param mode - The drag mode.
 * @param placement - The editing user's placement switches.
 * @param newTrackId - Supplies the id of a track created by dropping on the new-track zone.
 * @returns The command, or null when nothing changed or the clip no longer exists.
 * @throws {never} Never.
 */
export function timelineGestureCommand(
  document: TimelineDocumentV1, preview: TimelineGesturePreview, mode: TimelineGestureMode,
  placement: TimelineEditPlacement, newTrackId: () => string,
): TimelineEditCommand | null {
  const clip = document.clips[preview.clipId];
  if (clip === undefined) return null;
  if (mode === 'move') {
    if (preview.trackId === null) {
      return { operation: 'move', parameters: { clipId: clip.id, startFrame: preview.startFrame, newTrackId: newTrackId() }, placement };
    }
    const otherTrack = preview.trackId !== clip.trackId && document.tracks[preview.trackId] !== undefined;
    if (!otherTrack && preview.startFrame === clip.startFrame) return null;
    return { operation: 'move', parameters: { clipId: clip.id, startFrame: preview.startFrame, ...(otherTrack ? { trackId: preview.trackId } : {}) }, placement };
  }
  if (preview.startFrame === clip.startFrame && preview.sourceInFrame === clip.sourceInFrame && preview.durationFrames === clip.durationFrames) return null;
  return {
    operation: 'set_range',
    parameters: { clipId: clip.id, startFrame: preview.startFrame, sourceInFrame: preview.sourceInFrame, durationFrames: preview.durationFrames },
    placement,
  };
}
