// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
 * Clips by start frame then id, optionally only those on one track.
 * @param clips - All clips.
 * @param trackId - The track to keep, or undefined for every track.
 * @returns The ordered clips.
 * @throws {never} Never.
 */
export function orderedTimelineClips<T extends { id: string; trackId: string; startFrame: number }>(clips: Record<string, T>, trackId?: string): T[] {
  return Object.values(clips).filter((clip) => trackId === undefined || clip.trackId === trackId)
    .sort((a, b) => a.startFrame - b.startFrame || compareTimelineIds(a.id, b.id));
}
