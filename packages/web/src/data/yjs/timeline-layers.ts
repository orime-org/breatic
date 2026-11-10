// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { TimelineClip, TimelineDocumentV1, TimelineVideoClip } from '@breatic/shared';

import { timelineTrackRank } from '@web/data/yjs/timeline-order';

/**
 * Whether a clip shows over the clip shown so far: a higher-ranked track, or the same track and a smaller id.
 * @param clip - The candidate clip.
 * @param at - Its track rank.
 * @param shown - The clip shown so far, if any.
 * @param shownRank - Its track rank.
 * @returns Whether the candidate shows instead.
 * @throws {never} Never.
 */
function outranks(clip: TimelineClip, at: number, shown: TimelineClip | null, shownRank: number): boolean {
  return shown === null || at > shownRank || (at === shownRank && clip.id < shown.id);
}

/**
 * The clip the preview shows at a frame: the ready clip on the highest-ranked track covering it, ties by id.
 * @param document - The current document.
 * @param readyClipIds - Clips the arrangement resolved as ready.
 * @param frame - The Timeline frame.
 * @returns The shown clip, or null when no ready clip covers the frame.
 * @throws {never} Never.
 */
export function activeTimelineClipAt(document: TimelineDocumentV1, readyClipIds: ReadonlySet<string>, frame: number): TimelineVideoClip | null {
  const rank = timelineTrackRank(document.tracks);
  let shown: TimelineVideoClip | null = null;
  let shownRank = -1;
  for (const clip of Object.values(document.clips)) {
    const at = rank.get(clip.trackId);
    // A web-animation clip has no registered video, so the arrangement never resolves it as ready.
    if (clip.kind !== 'video' || at === undefined || !readyClipIds.has(clip.id) || frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
    if (outranks(clip, at, shown, shownRank)) {
      shown = clip;
      shownRank = at;
    }
  }
  return shown;
}

/**
 * Every ready clip the preview stacks at a frame, bottom-up by track rank (inner#1711 design §7.3). The highest video
 * hides everything below it, so only the web copies above it stack on it; ties on one rank go by id, as
 * `activeTimelineClipAt` decides.
 * @param document - The current document.
 * @param readyClipIds - Clips the arrangement resolved as ready.
 * @param frame - The Timeline frame.
 * @returns The visible clips, bottom-up.
 * @throws {never} Never.
 */
export function visibleTimelineClipsAt(document: TimelineDocumentV1, readyClipIds: ReadonlySet<string>, frame: number): TimelineClip[] {
  return visibleAt(document, timelineTrackRank(document.tracks), readyClipIds, frame);
}

/**
 * The body of `visibleTimelineClipsAt`, with the track ranks computed once.
 * @param document - The current document.
 * @param rank - Track id to rank.
 * @param readyClipIds - Ready clips.
 * @param frame - The frame.
 * @returns The visible clips, bottom-up.
 * @throws {never} Never.
 */
function visibleAt(document: TimelineDocumentV1, rank: ReadonlyMap<string, number>, readyClipIds: ReadonlySet<string>, frame: number): TimelineClip[] {
  const covering = Object.values(document.clips)
    .filter((clip) => rank.has(clip.trackId) && readyClipIds.has(clip.id) && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames)
    .sort((a, b) => (rank.get(a.trackId) ?? 0) - (rank.get(b.trackId) ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  let floor = 0;
  covering.forEach((clip, index) => { if (clip.kind === 'video') floor = index; });
  return covering.slice(floor);
}

/**
 * The next frame after `frame` where what the preview shows changes: an edge of a ready clip at which
 * `visibleTimelineClipsAt` differs from what is visible now; edges hidden under a higher video do not count.
 * @param document - The current document.
 * @param readyClipIds - Clips the arrangement resolved as ready.
 * @param frame - The current Timeline frame.
 * @param endFrame - The Timeline end, returned when no boundary comes first.
 * @returns The next boundary frame.
 * @throws {never} Never.
 */
export function nextTimelinePlaybackBoundary(document: TimelineDocumentV1, readyClipIds: ReadonlySet<string>, frame: number, endFrame: number): number {
  // What is visible changes only where a visible clip ends or where a clip that would show over the highest video
  // starts; clips starting under it stay hidden.
  const rank = timelineTrackRank(document.tracks);
  const shown = visibleAt(document, rank, readyClipIds, frame);
  const floor = shown[0]?.kind === 'video' ? shown[0] : null;
  const floorRank = floor === null ? -1 : rank.get(floor.trackId) ?? -1;
  let next = Math.min(endFrame, ...shown.map((clip) => clip.startFrame + clip.durationFrames));
  for (const clip of Object.values(document.clips)) {
    const at = rank.get(clip.trackId);
    if (at === undefined || !readyClipIds.has(clip.id) || clip.startFrame <= frame || clip.startFrame >= next) continue;
    if (floor === null || outranks(clip, at, floor, floorRank)) next = clip.startFrame;
  }
  return next;
}
