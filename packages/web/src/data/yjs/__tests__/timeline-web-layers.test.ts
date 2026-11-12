// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Stacking web-animation copies with video in the preview (inner#1711 design §7.3, breatic#1410 design §6.1).
 *
 * `visibleTimelineClipsAt(document, readyIds, frame)` is every ready clip covering the frame, bottom-up by track
 * rank; a higher video no longer hides what is under it, since a layer may be moved or scaled off what it covers.
 * `nextTimelinePlaybackBoundary` stops where a ready clip starts and where a web copy showing at the frame ends, under a
 * higher video or not; a video's end is not a boundary, since the lanes left play on.
 */

import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineDocumentV1 } from '@breatic/shared';
import { nextTimelinePlaybackBoundary, visibleTimelineClipsAt } from '@web/data/yjs/timeline-layers';
import { MAIN, V2, V3, V4, cid, clip, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { SRC_B, boundTo, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2), track(V4, 3)];

/**
 * A document whose every clip is ready.
 * @param clips - The clips.
 * @returns The document and its ready set.
 * @throws {Error} When the fixture is invalid.
 */
function stack(clips: TimelineClip[]): { document: TimelineDocumentV1; ready: Set<string> } {
  return { document: timeline(clips, TRACKS), ready: new Set(clips.map((item) => item.id)) };
}

/**
 * The ids visible at a frame, bottom-up.
 * @param clips - The ready clips.
 * @param frame - The frame.
 * @param ready - Overrides the ready set.
 * @returns The ids.
 * @throws {Error} When the fixture is invalid.
 */
function visibleIds(clips: TimelineClip[], frame: number, ready?: Set<string>): string[] {
  const { document, ready: all } = stack(clips);
  return visibleTimelineClipsAt(document, ready ?? all, frame).map((item) => item.id);
}

describe('visibleTimelineClipsAt', () => {
  it('shows a lone video', () => {
    expect(visibleIds([clip(cid(1), MAIN, 0, 48)], 10)).toEqual([cid(1)]);
  });

  it('stacks a web copy above the video under it, bottom-up', () => {
    expect(visibleIds([webClip(cid(2), V2, 0, 48), clip(cid(1), MAIN, 0, 48)], 10)).toEqual([cid(1), cid(2)]);
  });

  it('keeps a web copy under a higher video, below it', () => {
    expect(visibleIds([webClip(cid(2), V2, 0, 48), clip(cid(1), V3, 0, 48)], 10)).toEqual([cid(2), cid(1)]);
  });

  it('keeps every layer in track order, under and over each video', () => {
    const clips = [clip(cid(1), MAIN, 0, 48), webClip(cid(2), V2, 0, 48), clip(cid(3), V3, 0, 48), webClip(cid(4), V4, 0, 48, boundTo(SRC_B))];
    expect(visibleIds(clips, 10)).toEqual([cid(1), cid(2), cid(3), cid(4)]);
  });

  it('shows several web copies with no video, bottom-up', () => {
    expect(visibleIds([webClip(cid(4), V4, 0, 48), webClip(cid(2), V2, 0, 48)], 10)).toEqual([cid(2), cid(4)]);
  });

  it('leaves out clips that are not ready or do not cover the frame', () => {
    const clips = [clip(cid(1), MAIN, 0, 48), webClip(cid(2), V2, 0, 48), webClip(cid(3), V3, 20, 10)];
    expect(visibleIds(clips, 10, new Set([cid(1), cid(3)]))).toEqual([cid(1)]);
    expect(visibleIds(clips, 30)).toEqual([cid(1), cid(2)]);
  });
});

describe('nextTimelinePlaybackBoundary with web copies', () => {
  it('stops where a web copy above the video ends', () => {
    const { document, ready } = stack([clip(cid(1), MAIN, 0, 100), webClip(cid(2), V2, 0, 48)]);
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 100)).toBe(48);
  });

  it('stops where a web copy above the video starts', () => {
    const { document, ready } = stack([clip(cid(1), MAIN, 0, 100), webClip(cid(2), V2, 30, 10)]);
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 100)).toBe(30);
  });

  it('stops at the edges of a web copy under a higher video', () => {
    const { document, ready } = stack([clip(cid(1), V3, 0, 100), webClip(cid(2), V2, 0, 48), webClip(cid(3), V2, 60, 10)]);
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 100)).toBe(48);
    expect(nextTimelinePlaybackBoundary(document, ready, 48, 100)).toBe(60);
    expect(nextTimelinePlaybackBoundary(document, ready, 60, 100)).toBe(70);
    expect(nextTimelinePlaybackBoundary(document, ready, 70, 100)).toBe(100);
  });

  it('stops at the end of the only web copy when there is no video', () => {
    const { document, ready } = stack([webClip(cid(2), V2, 0, 48)]);
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 100)).toBe(48);
  });

  it('does not stop where a video ends: the next start or the end frame comes first', () => {
    const { document, ready } = stack([clip(cid(1), MAIN, 0, 48), clip(cid(2), V3, 0, 100), webClip(cid(3), V2, 60, 10)]);
    expect(nextTimelinePlaybackBoundary(document, ready, 0, 120)).toBe(60);
    expect(nextTimelinePlaybackBoundary(document, ready, 70, 120)).toBe(120);
  });

  it('stops where a web copy showing at the frame ends, and not at the end of one that is not showing', () => {
    const { document, ready } = stack([clip(cid(1), MAIN, 0, 100), webClip(cid(2), V2, 10, 30)]);
    expect(nextTimelinePlaybackBoundary(document, ready, 10, 100)).toBe(40);
    expect(nextTimelinePlaybackBoundary(document, ready, 39, 100)).toBe(40);
    expect(nextTimelinePlaybackBoundary(document, ready, 40, 100)).toBe(100);
  });
});
