// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What an external agent reads beside a picture of the Timeline (#1488
 * §19.1): the frames the track shows, the playhead and the clips on screen.
 */

import type { TimelineClip } from '@breatic/shared';

/** Said when web animations under the playhead are missing from the picture. */
export const WEB_NOT_DRAWN_NOTE =
  'Web animations play in sandboxed pages the capture cannot read, so the preview shows them empty; read these clips with the Timeline tools.';

/**
 * The frames the track shows right of its sticky headers.
 * @param viewport - The track scroller.
 * @param viewport.scrollLeft - How far it is scrolled.
 * @param viewport.clientWidth - How wide it is.
 * @param pixelsPerFrame - The zoom.
 * @param headerPx - The width of the track headers.
 * @returns The first frame and the frame past the last; at least one frame when the track has no width yet.
 */
export function visibleFrameRange(
  viewport: { scrollLeft: number; clientWidth: number },
  pixelsPerFrame: number,
  headerPx: number,
): { startFrame: number; endFrame: number } {
  const startFrame = Math.floor(viewport.scrollLeft / pixelsPerFrame);
  const endFrame = Math.max(startFrame + 1, Math.ceil((viewport.scrollLeft + viewport.clientWidth - headerPx) / pixelsPerFrame));
  return { startFrame, endFrame };
}

/**
 * The view data of a Timeline capture.
 * @param input - The clips, the playhead and the visible frames.
 * @param input.clips - Every clip.
 * @param input.frame - The playhead.
 * @param input.startFrame - The first visible frame.
 * @param input.endFrame - The frame past the last visible one.
 * @returns The view.
 */
export function timelineCaptureView(input: {
  clips: readonly TimelineClip[];
  frame: number;
  startFrame: number;
  endFrame: number;
}): Record<string, unknown> {
  const { clips, frame, startFrame, endFrame } = input;
  const visibleClipIds = clips
    .filter((clip) => clip.startFrame < endFrame && clip.startFrame + clip.durationFrames > startFrame)
    .map((clip) => clip.id);
  const notDrawn = clips
    .filter((clip) => clip.kind === 'web-animation' && clip.startFrame <= frame && frame < clip.startFrame + clip.durationFrames)
    .map((clip) => clip.id);
  return {
    kind: 'timeline',
    startFrame,
    endFrame,
    frame,
    visibleClipIds,
    ...(notDrawn.length > 0 ? { webAnimationsNotDrawn: notDrawn, note: WEB_NOT_DRAWN_NOTE } : {}),
  };
}
