// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { TimelineClip, TimelineDocumentV1 } from '@breatic/shared';

import { pickTimelineClipAt } from '@web/data/yjs/timeline-arrangement';
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
 * Whether a clip is drawn: every kind but sound (inner#1709).
 * @param clip - The clip.
 * @returns True when the preview draws it.
 * @throws {never} Never.
 */
export function isDrawnTimelineClip(clip: TimelineClip): boolean {
  return clip.kind !== 'audio';
}

/**
 * Whether a clip is heard: a video or a sound (inner#1709).
 * @param clip - The clip.
 * @returns True when the preview plays its sound.
 * @throws {never} Never.
 */
function isHeard(clip: TimelineClip): boolean {
  return clip.kind === 'video' || clip.kind === 'audio';
}

/**
 * Per track, the one clip that plays at a frame, kept when `keep` admits it, bottom-up by track rank (inner#1709
 * design §2.4): a later-starting clip covers the clips under it whatever their kinds.
 * @param document - The view document.
 * @param frame - The Timeline frame.
 * @param keep - Whether the playing clip is drawn or heard.
 * @returns The picked clips, bottom-up.
 * @throws {never} Never.
 */
function pickedAt(document: TimelineDocumentV1, frame: number, keep: (clip: TimelineClip) => boolean): TimelineClip[] {
  const rank = timelineTrackRank(document.tracks);
  return [...rank.keys()].flatMap((trackId) => {
    const clip = pickTimelineClipAt(document.clips, trackId, frame);
    return clip === undefined || !keep(clip) ? [] : [clip];
  }).sort(timelineStackOrder(rank));
}

/**
 * The clips the preview draws at a frame, bottom-up by track rank (#1410 design §6.1, inner#1709): per
 * track the one drawn clip that plays there. Each layer is placed by its own transform, so a video no longer hides the
 * layers below it.
 * @param document - The view document, whose clips are the ones `arrangeTimelineClips` keeps.
 * @param frame - The Timeline frame.
 * @returns The visible clips, bottom-up.
 * @throws {never} Never.
 */
export function visibleTimelineClipsAt(document: TimelineDocumentV1, frame: number): TimelineClip[] {
  return pickedAt(document, frame, isDrawnTimelineClip);
}

/**
 * The clips the preview hears at a frame (inner#1709): per track the one video or sound clip that plays there.
 * @param document - The view document.
 * @param frame - The Timeline frame.
 * @returns The audible clips, bottom-up.
 * @throws {never} Never.
 */
export function audibleTimelineClipsAt(document: TimelineDocumentV1, frame: number): TimelineClip[] {
  return pickedAt(document, frame, isHeard);
}

/**
 * The next frame after `frame` where play must check its layers (#1410 design §6.3, inner#1709): the start
 * of a clip after now; the end of a shown web copy, picture or text, since the frame changes there; and the end of a
 * clip playing now over another clip of its track that goes on past it, which comes back there. Where only a video or
 * a sound ends, the layers left go on.
 * @param document - The view document.
 * @param frame - The current Timeline frame.
 * @param endFrame - The Timeline end, returned when no boundary comes first.
 * @returns The next boundary frame.
 * @throws {never} Never.
 */
export function nextTimelinePlaybackBoundary(document: TimelineDocumentV1, frame: number, endFrame: number): number {
  const rank = timelineTrackRank(document.tracks);
  const clips = Object.values(document.clips).filter((clip) => rank.has(clip.trackId));
  let next = endFrame;
  for (const clip of clips) if (clip.startFrame > frame) next = Math.min(next, clip.startFrame);
  for (const trackId of rank.keys()) {
    const playing = pickTimelineClipAt(document.clips, trackId, frame);
    if (playing === undefined) continue;
    const end = playing.startFrame + playing.durationFrames;
    const ending = playing.kind === 'web-animation' || playing.kind === 'image' || playing.kind === 'text';
    const uncovers = clips.some((other) => other.trackId === trackId && other.startFrame <= frame && other.startFrame + other.durationFrames > end);
    if (ending || uncovers) next = Math.min(next, end);
  }
  return next;
}
