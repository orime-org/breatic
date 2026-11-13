// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { TimelineClip, TimelineDocumentV1 } from '@breatic/shared';

import { timelineTrackRank } from '@web/data/yjs/timeline-order';

/**
 * The preview's stacking order: bottom-up by track rank; ties on one rank put the smaller id on top.
 * @param rank - Each track's rank, from `timelineTrackRank`.
 * @returns The comparator.
 * @throws {never} Never.
 */
export function timelineStackOrder(rank: ReadonlyMap<string, number>): (a: TimelineClip, b: TimelineClip) => number {
  return (a, b) => (rank.get(a.trackId) ?? 0) - (rank.get(b.trackId) ?? 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * Every ready clip the preview stacks at a frame, bottom-up by track rank (#1410 design §6.1). Each layer is placed by
 * its own transform, so a video no longer hides the layers below it.
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
    .sort(timelineStackOrder(rank));
}

/**
 * The next frame after `frame` where play must check its layers (#1410 design §6.3): the start of a ready clip after
 * now, or the end of a web copy showing now, since its instance can pass to another copy there. Where only videos end,
 * the layers left go on, as nothing below them is hidden.
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
    const at = clip.startFrame > frame ? clip.startFrame : clip.kind === 'web-animation' ? clip.startFrame + clip.durationFrames : endFrame;
    if (at > frame) next = Math.min(next, at);
  }
  return next;
}
