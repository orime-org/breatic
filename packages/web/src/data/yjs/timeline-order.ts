// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { TimelineTrack, TimelineVideoClip } from '@breatic/shared';

/**
 * Compare identities in code-unit order, independent of a client's locale.
 * @param left - The first identity.
 * @param right - The second identity.
 * @returns Their stable order.
 * @throws {never} Never.
 */
export function compareTimelineIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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
 * Clips by start frame then id, optionally only those on one track.
 * @param clips - All clips.
 * @param trackId - The track to keep, or undefined for every track.
 * @returns The ordered clips.
 * @throws {never} Never.
 */
export function orderedTimelineClips(clips: Record<string, TimelineVideoClip>, trackId?: string): TimelineVideoClip[] {
  return Object.values(clips).filter((clip) => trackId === undefined || clip.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame || compareTimelineIds(a.id, b.id));
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
