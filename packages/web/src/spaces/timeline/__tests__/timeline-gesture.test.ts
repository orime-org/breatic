// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Drag and trim previews and the single command a release commits (inner#1708 E1, E2, E9, design §2.4, §5.1).
 *
 * Sources run at rate 1/1 on the Timeline's own timebase, so a source offset equals the timeline offset,
 * except in the last block, whose source timebase differs from the Timeline rate.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  orderedTimelineClips, planTimelineEdit, timelineInsertionIndex, TimelineDocumentV1Schema,
  type TimelineDocumentV1, type TimelineVideoClip, type TimelineVideoSource,
} from '@breatic/shared';

import { previewTimelineGesture, timelineGestureCommand, timelineInsertMarkerFrame, type TimelineGestureMode } from '@web/spaces/timeline/timeline-gesture';
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

describe('gestures on the magnetic main track (inner#1708 C3, C4)', () => {
  const MAGNET = { ...FREE, magnet: true };
  const C = cid(3);

  /**
   * Preview a gesture, build its command and plan it: the clip's planned placement.
   * @param document - The document.
   * @param clipId - The dragged clip.
   * @param mode - The drag mode.
   * @param delta - The pointer travel in frames.
   * @param hover - The hovered row.
   * @returns The preview and the planned clip.
   * @throws {Error} When no preview, command or accepted plan results.
   */
  function roundTrip(document: TimelineDocumentV1, clipId: string, mode: TimelineGestureMode, delta: number, hover: string | 'new' | null): { preview: NonNullable<ReturnType<typeof previewTimelineGesture>>; planned: TimelineVideoClip; next: TimelineDocumentV1 } {
    const preview = previewTimelineGesture(document, clipId, mode, delta, hover, MAGNET);
    if (preview === null) throw new Error('Expected a preview');
    const command = timelineGestureCommand(document, preview, mode, ON, newTrack);
    if (command === null) throw new Error('Expected a command');
    const plan = planTimelineEdit(document, command, idFactory('60000000'));
    if (!plan.ok) throw new Error(`Expected an accepted plan, got ${plan.reason}`);
    const planned = plan.next.clips[clipId];
    if (planned === undefined) throw new Error('Expected the clip to remain');
    return { preview, planned, next: plan.next };
  }

  it('extends the head of the first main clip back over its trimmed source frames', () => {
    const document = timeline([clip(A, MAIN, 0, 20, { sourceInFrame: 20 }), clip(B, MAIN, 20, 10)], [track(MAIN, 0)]);
    const preview = previewTimelineGesture(document, A, 'trim-start', -10, null, MAGNET);
    expect(preview).toMatchObject({ startFrame: 0, sourceInFrame: 10, durationFrames: 30 });
    if (preview === null) return;
    expect(timelineGestureCommand(document, preview, 'trim-start', ON, newTrack)).not.toBe(null);
    const { planned, next } = roundTrip(document, A, 'trim-start', -10, null);
    expect(planned).toMatchObject({ startFrame: 0, sourceInFrame: 10, durationFrames: 30 });
    expect(next.clips[B]?.startFrame).toBe(30);
  });

  it('previews a same-track move at the drop frame and marks the gap the planner inserts it into (D2)', () => {
    // A[0,10) B[10,20) C[20,30); dragging A by 15 drops it past B's midpoint: the gap after B, landing at 10.
    const document = timeline([clip(A, MAIN, 0, 10), clip(B, MAIN, 10, 10), clip(C, MAIN, 20, 10)], [track(MAIN, 0)]);
    const preview = previewTimelineGesture(document, A, 'move', 15, null, MAGNET);
    expect(preview).toMatchObject({ trackId: MAIN, startFrame: 15 });
    expect(preview).not.toHaveProperty('dropFrame');
    expect(timelineInsertMarkerFrame(document, A, 15)).toBe(20);
    if (preview === null) return;
    expect(timelineGestureCommand(document, preview, 'move', ON, newTrack)).toMatchObject({ operation: 'move', parameters: { clipId: A, startFrame: 15 } });
    const { planned, next } = roundTrip(document, A, 'move', 15, null);
    expect(planned.startFrame).toBe(10);
    expect(next.clips[B]?.startFrame).toBe(0);
  });

  it('previews a move from a sub track onto the main track at the drop frame (D2)', () => {
    const document = timeline([clip(A, MAIN, 0, 48), clip(C, MAIN, 48, 48), clip(B, 'v2', 100, 48)], [track(MAIN, 0), track('v2', 1)]);
    const { preview, planned } = roundTrip(document, B, 'move', -40, MAIN);
    expect(preview).toMatchObject({ trackId: MAIN, startFrame: 60 });
    expect(timelineInsertMarkerFrame(document, B, 60)).toBe(48);
    expect(planned).toMatchObject({ trackId: MAIN, startFrame: 48 });
  });

  it('marks frame 0 when the drop comes before every main clip (D2)', () => {
    const document = timeline([clip(A, MAIN, 0, 10), clip(B, MAIN, 10, 10), clip(C, MAIN, 20, 10)], [track(MAIN, 0)]);
    expect(timelineInsertMarkerFrame(document, C, 0)).toBe(0);
    expect(timelineInsertMarkerFrame(document, C, 4)).toBe(0);
  });

  it('previews every main-track move at its drop frame, commits it and marks where the planner inserts it (D2)', () => {
    fc.assert(fc.property(
      conflictFreeDocument(),
      fc.nat(),
      fc.integer({ min: -200, max: 200 }),
      (document, pick, delta) => {
        const ids = Object.keys(document.clips);
        const clipId = ids[pick % ids.length] ?? '';
        const moved = document.clips[clipId];
        if (moved === undefined) return;
        const preview = previewTimelineGesture(document, clipId, 'move', delta, MAIN, { ...FREE, magnet: true });
        if (preview === null) return;
        expect(preview.startFrame).toBe(Math.max(0, moved.startFrame + delta));
        // Reference: the gap before the insertion index in the current layout, and the packed landing.
        const sequence = orderedTimelineClips(document.clips, MAIN).filter((item) => item.id !== clipId);
        const index = timelineInsertionIndex(sequence, preview.startFrame);
        const before = sequence[index - 1];
        expect(timelineInsertMarkerFrame(document, clipId, preview.startFrame)).toBe(before === undefined ? 0 : before.startFrame + before.durationFrames);
        const command = timelineGestureCommand(document, preview, 'move', ON, newTrack);
        if (command === null) return;
        expect(command).toMatchObject({ operation: 'move', parameters: { clipId, startFrame: preview.startFrame } });
        const plan = planTimelineEdit(document, command, idFactory('60000000'));
        expect(plan).toMatchObject({ ok: true });
        if (!plan.ok) return;
        const landing = sequence.slice(0, index).reduce((at, item) => at + item.durationFrames, 0);
        expect(plan.next.clips[clipId]).toMatchObject({ trackId: MAIN, startFrame: landing });
      },
    ), { numRuns: 400 });
  });
});

describe('head trims when the source timebase differs from the Timeline rate (inner#1708 D4)', () => {
  /** 4 s at 50 frames per second on a 25 fps Timeline. */
  const SOURCE50: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000050', timebase: { num: 50, den: 1 }, extentFrames: 200, durationSeconds: '4' };

  /**
   * A 25 fps Timeline holding one clip of the 50 fps source on v2.
   * @param placed - The clip.
   * @returns The document.
   * @throws {Error} When the fixture is invalid.
   */
  function at25(placed: TimelineVideoClip): TimelineDocumentV1 {
    return TimelineDocumentV1Schema.parse({ ...timeline([placed], [track(MAIN, 0), track('v2', 1)], [SOURCE50]), settings: { width: 1920, height: 1080, fps: { num: 25, den: 1 } } });
  }

  it('moves the in-point by the source frames the head travels', () => {
    const document = at25(clip(A, 'v2', 0, 100, { sourceId: SOURCE50.id }));
    expect(previewTimelineGesture(document, A, 'trim-start', 10, null, FREE)).toMatchObject({ startFrame: 10, sourceInFrame: 20, durationFrames: 90 });
  });

  it('stops the head at the source start in Timeline frames', () => {
    const document = at25(clip(A, 'v2', 20, 80, { sourceId: SOURCE50.id, sourceInFrame: 20 }));
    expect(previewTimelineGesture(document, A, 'trim-start', -15, null, FREE)).toMatchObject({ startFrame: 10, sourceInFrame: 0, durationFrames: 90 });
  });

  it('commits a head trim the planner accepts', () => {
    const document = at25(clip(A, 'v2', 0, 100, { sourceId: SOURCE50.id }));
    const preview = previewTimelineGesture(document, A, 'trim-start', 10, null, FREE);
    if (preview === null) throw new Error('Expected a preview');
    const command = timelineGestureCommand(document, preview, 'trim-start', OFF, newTrack);
    if (command === null) throw new Error('Expected a command');
    const plan = planTimelineEdit(document, command, idFactory('60000000'));
    if (!plan.ok) throw new Error(`Expected an accepted plan, got ${plan.reason}`);
    expect(plan.next.clips[A]).toMatchObject({ startFrame: 10, sourceInFrame: 20, durationFrames: 90 });
  });
});
