// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineDocumentV1 } from '@breatic/shared';

/** How close, in screen pixels, a dragged edge must come to a target to snap. */
export const TIMELINE_SNAP_PX = 8;

/**
 * The smallest shift that brings one of `edges` onto one of `targets` within the pixel threshold.
 * @param edges - The dragged edges, in frames.
 * @param targets - Frames an edge may snap to.
 * @param pixelsPerFrame - The current zoom.
 * @param thresholdPx - The snapping distance in pixels.
 * @returns The shift and the target it lands on, or null when no target is close enough.
 * @throws {never} Never.
 */
export function snapTimelineEdges(edges: readonly number[], targets: readonly number[], pixelsPerFrame: number, thresholdPx: number): { shift: number; frame: number } | null {
  let best: { shift: number; frame: number } | null = null;
  for (const edge of edges) {
    for (const target of targets) {
      const shift = target - edge;
      if (Math.abs(shift) * pixelsPerFrame > thresholdPx) continue;
      if (best === null || Math.abs(shift) < Math.abs(best.shift)) best = { shift, frame: target };
    }
  }
  return best;
}

/**
 * Frames a dragged clip may snap to: every other clip's start and end, the playhead and frame 0.
 * @param document - The current document.
 * @param excludeClipId - The dragged clip.
 * @param playhead - The current playhead frame.
 * @returns The distinct target frames.
 * @throws {never} Never.
 */
export function timelineSnapTargets(document: TimelineDocumentV1, excludeClipId: string, playhead: number): number[] {
  const targets = new Set([0, playhead]);
  for (const clip of Object.values(document.clips)) {
    if (clip.id === excludeClipId) continue;
    targets.add(clip.startFrame);
    targets.add(clip.startFrame + clip.durationFrames);
  }
  return [...targets];
}
