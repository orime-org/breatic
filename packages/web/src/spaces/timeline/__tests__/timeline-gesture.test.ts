// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Drag and trim previews and the single command a release commits (inner#1708 E1, E2, E9, design §2.4, §5.1).
 *
 * Every source here runs at rate 1/1, so a source offset equals the timeline offset.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { planTimelineEdit, type TimelineDocumentV1, type TimelineVideoClip } from '@breatic/shared';

import { previewTimelineGesture, timelineGestureCommand, type TimelineGestureMode } from '@web/spaces/timeline/timeline-gesture';
import {
  MAIN, OFF, ON, SHORT_SOURCE, SOURCE, cid, clip, idFactory, timeline, track,
} from '@web/spaces/timeline/__tests__/timeline-edit-fixtures';

const A = cid(1);
const B = cid(2);
const NEW_TRACK = 'track-new-1';
const FREE = { snap: false, pixelsPerFrame: 1, playhead: 0 };
const SNAP = { snap: true, pixelsPerFrame: 1, playhead: 500 };

/** A at main [0,48), B at v2 [100,148) with source-in 10, on a 1000-frame source. */
const DOC = timeline([clip(A, MAIN, 0, 48), clip(B, 'v2', 100, 48, { sourceInFrame: 10 })], [track(MAIN, 0), track('v2', 1), track('v3', 2)]);

/**
 * A fixed id supplier for a new track.
 * @returns The id.
 * @throws {never} Never.
 */
function newTrack(): string {
  return NEW_TRACK;
}

describe('previewTimelineGesture move', () => {
  it('keeps the track when nothing is hovered and adds the delta', () => {
    expect(previewTimelineGesture(DOC, B, 'move', 30, null, FREE)).toEqual({
      clipId: B, trackId: 'v2', startFrame: 130, sourceInFrame: 10, durationFrames: 48, snapFrame: null,
    });
  });

  it('clamps the start at frame 0', () => {
    expect(previewTimelineGesture(DOC, B, 'move', -500, null, FREE)?.startFrame).toBe(0);
  });

  it('targets a hovered existing track', () => {
    expect(previewTimelineGesture(DOC, B, 'move', 0, 'v3', FREE)?.trackId).toBe('v3');
    expect(previewTimelineGesture(DOC, B, 'move', 0, MAIN, FREE)?.trackId).toBe(MAIN);
  });

  it('targets the new-track zone as a null track', () => {
    expect(previewTimelineGesture(DOC, B, 'move', 0, 'new', FREE)?.trackId).toBe(null);
  });

  it('falls back to the origin track when the hovered track was removed', () => {
    expect(previewTimelineGesture(DOC, B, 'move', 0, 'track-gone', FREE)?.trackId).toBe('v2');
  });

  it('snaps the nearer of both edges to another clip edge', () => {
    // Start 54 lies 6 frames from A's end at 48; the end 102 has nothing within 8 frames.
    expect(previewTimelineGesture(DOC, B, 'move', -46, null, SNAP)).toMatchObject({ startFrame: 48, snapFrame: 48 });
    // End 498 lies 2 frames from the playhead at 500.
    expect(previewTimelineGesture(DOC, B, 'move', 350, null, SNAP)).toMatchObject({ startFrame: 452, snapFrame: 500 });
  });

  it('does not snap with snapping off', () => {
    expect(previewTimelineGesture(DOC, B, 'move', -46, null, { ...SNAP, snap: false })).toMatchObject({ startFrame: 54, snapFrame: null });
  });

  it('returns null when the clip is gone', () => {
    expect(previewTimelineGesture(DOC, cid(99), 'move', 10, null, FREE)).toBe(null);
  });
});

describe('previewTimelineGesture trims', () => {
  it('moves the start edge with the source in-point and keeps the end', () => {
    expect(previewTimelineGesture(DOC, B, 'trim-start', 5, null, FREE)).toEqual({
      clipId: B, trackId: 'v2', startFrame: 105, sourceInFrame: 15, durationFrames: 43, snapFrame: null,
    });
    expect(previewTimelineGesture(DOC, B, 'trim-start', -4, null, FREE)).toMatchObject({ startFrame: 96, sourceInFrame: 6, durationFrames: 52 });
  });

  it('stops the start edge at the source start', () => {
    expect(previewTimelineGesture(DOC, B, 'trim-start', -50, null, FREE)).toMatchObject({ startFrame: 90, sourceInFrame: 0, durationFrames: 58 });
  });

  it('stops the start edge at frame 0 before the source start', () => {
    const document = timeline([clip(A, MAIN, 5, 20, { sourceInFrame: 30 })]);
    expect(previewTimelineGesture(document, A, 'trim-start', -20, null, FREE)).toMatchObject({ startFrame: 0, sourceInFrame: 25, durationFrames: 25 });
  });

  it('keeps at least one frame when trimming the start', () => {
    expect(previewTimelineGesture(DOC, B, 'trim-start', 100, null, FREE)).toMatchObject({ startFrame: 147, sourceInFrame: 57, durationFrames: 1 });
  });

  it('moves only the end edge', () => {
    expect(previewTimelineGesture(DOC, B, 'trim-end', 12, null, FREE)).toEqual({
      clipId: B, trackId: 'v2', startFrame: 100, sourceInFrame: 10, durationFrames: 60, snapFrame: null,
    });
  });

  it('stops the end edge at the source extent', () => {
    const document = timeline([clip(A, MAIN, 0, 30, { sourceId: SHORT_SOURCE.id, sourceInFrame: 10 })]);
    expect(previewTimelineGesture(document, A, 'trim-end', 50, null, FREE)).toMatchObject({ durationFrames: SHORT_SOURCE.extentFrames - 10 });
    expect(previewTimelineGesture(DOC, B, 'trim-end', 5000, null, FREE)).toMatchObject({ durationFrames: SOURCE.extentFrames - 10 });
  });

  it('keeps at least one frame when trimming the end', () => {
    expect(previewTimelineGesture(DOC, B, 'trim-end', -100, null, FREE)).toMatchObject({ startFrame: 100, durationFrames: 1 });
  });

  it('snaps only the moved edge', () => {
    // Trim end to 153: the playhead at 155 is 2 frames away.
    expect(previewTimelineGesture(DOC, B, 'trim-end', 5, null, { ...SNAP, playhead: 155 })).toMatchObject({ startFrame: 100, durationFrames: 55, snapFrame: 155 });
    // Trim start to 52: A's end at 48 is 4 frames away; the fixed end at 148 (2 from the playhead) does not take part.
    const deep = timeline([clip(A, MAIN, 0, 48), clip(B, 'v2', 100, 48, { sourceInFrame: 100 })]);
    expect(previewTimelineGesture(deep, B, 'trim-start', -48, null, { ...SNAP, playhead: 150 })).toMatchObject({ startFrame: 48, sourceInFrame: 48, durationFrames: 100, snapFrame: 48 });
  });

  it('ignores the hovered track while trimming', () => {
    expect(previewTimelineGesture(DOC, B, 'trim-end', 5, 'v3', FREE)?.trackId).toBe('v2');
  });
});

describe('timelineGestureCommand', () => {
  it('commits a same-track move', () => {
    const preview = previewTimelineGesture(DOC, B, 'move', 30, null, FREE);
    if (preview === null) throw new Error('Expected a preview');
    const command = timelineGestureCommand(DOC, preview, 'move', ON, newTrack);
    expect(command).toMatchObject({ operation: 'move', parameters: { clipId: B, startFrame: 130 }, placement: ON });
    if (command?.operation !== 'move') throw new Error('Expected a move');
    expect(command.parameters.newTrackId).toBe(undefined);
    expect([undefined, 'v2']).toContain(command.parameters.trackId);
  });

  it('commits a move to another track with its trackId', () => {
    const preview = previewTimelineGesture(DOC, B, 'move', 0, 'v3', FREE);
    if (preview === null) throw new Error('Expected a preview');
    expect(timelineGestureCommand(DOC, preview, 'move', OFF, newTrack)).toEqual({
      operation: 'move', parameters: { clipId: B, startFrame: 100, trackId: 'v3' }, placement: OFF,
    });
  });

  it('commits a move to the new-track zone with a fresh newTrackId', () => {
    const preview = previewTimelineGesture(DOC, B, 'move', 10, 'new', FREE);
    if (preview === null) throw new Error('Expected a preview');
    expect(timelineGestureCommand(DOC, preview, 'move', ON, newTrack)).toEqual({
      operation: 'move', parameters: { clipId: B, startFrame: 110, newTrackId: NEW_TRACK }, placement: ON,
    });
  });

  it('keeps the origin track when the previewed track was removed before release', () => {
    const preview = previewTimelineGesture(DOC, B, 'move', 20, 'v3', FREE);
    if (preview === null) throw new Error('Expected a preview');
    const later = timeline(Object.values(DOC.clips), [track(MAIN, 0), track('v2', 1)]);
    const command = timelineGestureCommand(later, preview, 'move', OFF, newTrack);
    expect(command).toMatchObject({ operation: 'move', parameters: { clipId: B, startFrame: 120 } });
    if (command?.operation !== 'move') throw new Error('Expected a move');
    expect([undefined, 'v2']).toContain(command.parameters.trackId);
    expect(command.parameters.newTrackId).toBe(undefined);
  });

  it.each(['trim-start', 'trim-end'] as const)('commits %s as set_range', (mode) => {
    const preview = previewTimelineGesture(DOC, B, mode, 6, null, FREE);
    if (preview === null) throw new Error('Expected a preview');
    expect(timelineGestureCommand(DOC, preview, mode, OFF, newTrack)).toEqual({
      operation: 'set_range',
      parameters: { clipId: B, startFrame: preview.startFrame, sourceInFrame: preview.sourceInFrame, durationFrames: preview.durationFrames },
      placement: OFF,
    });
  });

  it.each(['move', 'trim-start', 'trim-end'] as const)('returns null for an unchanged %s', (mode) => {
    const preview = previewTimelineGesture(DOC, B, mode, 0, null, FREE);
    if (preview === null) throw new Error('Expected a preview');
    expect(timelineGestureCommand(DOC, preview, mode, ON, newTrack)).toBe(null);
  });

  it('returns null when the clip vanished before release', () => {
    const preview = previewTimelineGesture(DOC, B, 'move', 20, null, FREE);
    if (preview === null) throw new Error('Expected a preview');
    const later = timeline([clip(A, MAIN, 0, 48)], [track(MAIN, 0), track('v2', 1), track('v3', 2)]);
    expect(timelineGestureCommand(later, preview, 'move', OFF, newTrack)).toBe(null);
  });

  it('never asks for a new track id unless the new-track zone was the target', () => {
    let asked = 0;
    const counting = (): string => { asked += 1; return NEW_TRACK; };
    for (const mode of ['move', 'trim-start', 'trim-end'] as const) {
      const preview = previewTimelineGesture(DOC, B, mode, 7, mode === 'move' ? 'v3' : null, FREE);
      if (preview !== null) timelineGestureCommand(DOC, preview, mode, ON, counting);
    }
    expect(asked).toBe(0);
  });
});

/**
 * A conflict-free document: main clips end to end or with gaps, sub-track clips apart, all inside the source.
 * @returns The document arbitrary.
 * @throws {never} Never.
 */
function conflictFreeDocument(): fc.Arbitrary<TimelineDocumentV1> {
  const lane = fc.array(fc.record({ gap: fc.integer({ min: 0, max: 30 }), duration: fc.integer({ min: 1, max: 60 }), sourceIn: fc.integer({ min: 0, max: 40 }) }), { maxLength: 4 });
  return fc.tuple(lane, lane, lane).map((lanes) => {
    const tracks = [track(MAIN, 0), track('v2', 1), track('v3', 2)];
    const clips: TimelineVideoClip[] = [];
    let n = 1;
    lanes.forEach((items, laneIndex) => {
      let at = 0;
      for (const item of items) {
        at += item.gap;
        clips.push(clip(cid(n), tracks[laneIndex]?.id ?? MAIN, at, item.duration, { sourceInFrame: item.sourceIn }));
        at += item.duration;
        n += 1;
      }
    });
    return timeline(clips, tracks, [SOURCE]);
  }).filter((document) => Object.keys(document.clips).length > 0);
}

describe('timelineGestureCommand property', () => {
  it('produces only commands the planner accepts on a conflict-free document', () => {
    fc.assert(fc.property(
      conflictFreeDocument(),
      fc.nat(),
      fc.constantFrom<TimelineGestureMode>('move', 'trim-start', 'trim-end'),
      fc.integer({ min: -200, max: 200 }),
      fc.constantFrom<string | 'new' | null>(null, 'new', MAIN, 'v2', 'v3', 'track-gone'),
      fc.boolean(),
      fc.record({ magnet: fc.boolean(), linkage: fc.boolean() }),
      fc.integer({ min: 0, max: 400 }),
      (document, pick, mode, delta, hover, snap, placement, playhead) => {
        const ids = Object.keys(document.clips);
        const clipId = ids[pick % ids.length] ?? '';
        const preview = previewTimelineGesture(document, clipId, mode, delta, hover, { snap, pixelsPerFrame: 1, playhead });
        expect(preview).not.toBe(null);
        if (preview === null) return;
        const command = timelineGestureCommand(document, preview, mode, placement, idFactory('50000000'));
        if (command === null) return;
        const plan = planTimelineEdit(document, command, idFactory('60000000'));
        expect(plan).toMatchObject({ ok: true });
      },
    ), { numRuns: 400 });
  });
});
