// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { compareTimelineIds, type TimelineTrack } from '@breatic/shared';

export { compareTimelineIds, orderedTimelineClips } from '@breatic/shared';

/**
 * Tracks bottom-up by stacking order, ties by id.
 * @param tracks - All tracks.
 * @returns The ordered tracks.
 * @throws {never} Never.
 */
export function orderedTimelineTracks(tracks: Record<string, TimelineTrack>): TimelineTrack[] {
  return Object.values(tracks).sort((a, b) => a.order - b.order || compareTimelineIds(a.id, b.id));
}

/**
 * Each track's stacking rank: its index in `orderedTimelineTracks`, so tracks sharing an order still stack apart.
 * @param tracks - All tracks.
 * @returns Track id to rank, bottom track 0.
 * @throws {never} Never.
 */
export function timelineTrackRank(tracks: Record<string, TimelineTrack>): Map<string, number> {
  return new Map(orderedTimelineTracks(tracks).map((track, rank) => [track.id, rank]));
}
