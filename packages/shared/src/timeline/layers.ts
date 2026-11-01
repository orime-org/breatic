// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineDocumentV1, TimelineVideoClip } from "@shared/timeline/schema.js";

/**
 * The clip the preview shows at a frame: the ready clip on the highest-order track covering it, ties by id.
 * @param document - The current document.
 * @param readyClipIds - Clips the arrangement resolved as ready.
 * @param frame - The Timeline frame.
 * @returns The shown clip, or null when no ready clip covers the frame.
 * @throws {never} Never.
 */
export function activeTimelineClipAt(document: TimelineDocumentV1, readyClipIds: ReadonlySet<string>, frame: number): TimelineVideoClip | null {
  let shown: TimelineVideoClip | null = null;
  let shownOrder = -1;
  for (const clip of Object.values(document.clips)) {
    const order = document.tracks[clip.trackId]?.order;
    if (order === undefined || !readyClipIds.has(clip.id) || frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
    if (shown === null || order > shownOrder || (order === shownOrder && clip.id < shown.id)) {
      shown = clip;
      shownOrder = order;
    }
  }
  return shown;
}

/**
 * The next frame after `frame` where the shown clip changes: an edge of a ready clip at which
 * `activeTimelineClipAt` differs from the clip shown now; edges hidden under a higher track do not count.
 * @param document - The current document.
 * @param readyClipIds - Clips the arrangement resolved as ready.
 * @param frame - The current Timeline frame.
 * @param endFrame - The Timeline end, returned when no boundary comes first.
 * @returns The next boundary frame.
 * @throws {never} Never.
 */
export function nextTimelinePlaybackBoundary(document: TimelineDocumentV1, readyClipIds: ReadonlySet<string>, frame: number, endFrame: number): number {
  // The shown clip changes only where it ends or where a clip that outranks it starts.
  const shown = activeTimelineClipAt(document, readyClipIds, frame);
  const shownOrder = shown === null ? -1 : document.tracks[shown.trackId]?.order ?? -1;
  let next = shown === null ? endFrame : Math.min(endFrame, shown.startFrame + shown.durationFrames);
  for (const clip of Object.values(document.clips)) {
    const order = document.tracks[clip.trackId]?.order;
    if (order === undefined || !readyClipIds.has(clip.id) || clip.startFrame <= frame || clip.startFrame >= next) continue;
    if (shown === null || order > shownOrder || (order === shownOrder && clip.id < shown.id)) next = clip.startFrame;
  }
  return next;
}
