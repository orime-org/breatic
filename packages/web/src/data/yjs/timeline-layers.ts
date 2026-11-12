// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { TimelineClip, TimelineDocumentV1 } from '@breatic/shared';

import { timelineTrackRank } from '@web/data/yjs/timeline-order';

/**
 * Every ready clip the preview stacks at a frame, bottom-up by track rank (#1410 design §6.1). Each layer is placed by
 * its own transform, so a video no longer hides the layers below it; ties on one rank put the smaller id on top.
 * @param document - The current document.
 * @param readyClipIds - Clips the arrangement resolved as ready.
 * @param frame - The Timeline frame.
 * @returns The visible clips, bottom-up.
 * @throws {never} Never.
 */
export function visibleTimelineClipsAt(document: TimelineDocumentV1, readyClipIds: ReadonlySet<string>, frame: number): TimelineClip[] {
  const rank = timelineTrackRank(document.tracks);
  return Object.values(document.clips)
    .filter((clip) => rank.has(clip.trackId) && readyClipIds.has(clip.id) && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames)
    .sort((a, b) => (rank.get(a.trackId) ?? 0) - (rank.get(b.trackId) ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * The next frame after `frame` where what the preview shows changes: the earliest end of a clip visible now, or start of
 * a ready clip after now.
 * @param document - The current document.
 * @param readyClipIds - Clips the arrangement resolved as ready.
 * @param frame - The current Timeline frame.
 * @param endFrame - The Timeline end, returned when no boundary comes first.
 * @returns The next boundary frame.
 * @throws {never} Never.
 */
export function nextTimelinePlaybackBoundary(document: TimelineDocumentV1, readyClipIds: ReadonlySet<string>, frame: number, endFrame: number): number {
  const rank = timelineTrackRank(document.tracks);
  let next = endFrame;
  for (const clip of Object.values(document.clips)) {
    if (!rank.has(clip.trackId) || !readyClipIds.has(clip.id)) continue;
    const end = clip.startFrame + clip.durationFrames;
    if (clip.startFrame > frame) next = Math.min(next, clip.startFrame);
    else if (frame < end) next = Math.min(next, end);
  }
  return next;
}
