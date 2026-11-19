// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '@breatic/shared';
import { WEB_NOT_DRAWN_NOTE, timelineCaptureView, visibleFrameRange } from '@web/spaces/timeline/timeline-view-capture';

const BASE = { trackId: 't1', sourceInFrame: 0, rate: { num: 30, den: 1 }, gain: 1, mute: false, transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 } };

/**
 * A clip on the track.
 * @param id - Its id.
 * @param kind - Its kind.
 * @param startFrame - Where it starts.
 * @param durationFrames - How long it runs.
 * @returns It.
 */
function clip(id: string, kind: 'video' | 'web-animation', startFrame: number, durationFrames: number): TimelineClip {
  return kind === 'video'
    ? { ...BASE, id, kind, sourceId: 's', startFrame, durationFrames }
    : { ...BASE, id, kind, startFrame, durationFrames, contentBinding: { baseSourceResultId: 'r', operationId: null } };
}

describe('visibleFrameRange', () => {
  it('reads the frames right of the track headers', () => {
    expect(visibleFrameRange({ scrollLeft: 100, clientWidth: 600 }, 2, 200)).toEqual({ startFrame: 50, endFrame: 250 });
  });

  it('keeps one frame for a track not laid out yet', () => {
    expect(visibleFrameRange({ scrollLeft: 0, clientWidth: 0 }, 2, 200)).toEqual({ startFrame: 0, endFrame: 1 });
  });
});

describe('timelineCaptureView (#1488 design 19.1)', () => {
  const clips = [clip('early', 'video', 0, 40), clip('seen', 'video', 45, 20), clip('web', 'web-animation', 55, 30), clip('late', 'video', 300, 10)];

  it('names the clips in the visible range and the playhead', () => {
    const view = timelineCaptureView({ clips, frame: 60, startFrame: 50, endFrame: 250 });
    expect(view).toMatchObject({ kind: 'timeline', startFrame: 50, endFrame: 250, frame: 60, visibleClipIds: ['seen', 'web'] });
  });

  it('says which web animations under the playhead the picture leaves out', () => {
    expect(timelineCaptureView({ clips, frame: 60, startFrame: 50, endFrame: 250 })).toMatchObject({ webAnimationsNotDrawn: ['web'], note: WEB_NOT_DRAWN_NOTE });
    const quiet = timelineCaptureView({ clips, frame: 100, startFrame: 50, endFrame: 250 });
    expect(quiet).not.toHaveProperty('webAnimationsNotDrawn');
    expect(quiet).not.toHaveProperty('note');
  });

  it('counts a clip ending exactly at the range start as outside', () => {
    expect(timelineCaptureView({ clips, frame: 0, startFrame: 40, endFrame: 44 }).visibleClipIds).toEqual([]);
  });
});
