// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { planTimelineEdit, timelineSourceOverflow } from '@web/data/yjs/timeline-edit';
import { validateTimelineRange } from '@web/data/yjs/timeline-time';
import type { TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { TIMELINE_MAIN_TRACK_ID, TimelineDocumentV1Schema } from '@breatic/shared';
import { TimelineEditCommandSchema } from '@web/data/yjs/timeline-edit';
import type { TimelineDocumentV1, TimelineVideoClip } from '@breatic/shared';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import {
  FPS, LINK_ONLY, MAGNET_ONLY, MAIN, OFF, ON, SHORT_SOURCE, SOURCE, V2, V3, V4,
  cid, clip, idFactory, overlapSpans, overlappedFrames, referenceOverflow, starts, timeline, totalOverflow, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';

type Accepted = Extract<TimelineEditPlan, { ok: true }>;

const REASONS = [
  'target_missing', 'track_missing', 'invalid_range', 'overlap', 'id_taken', 'main_track', 'track_not_empty', 'source_unavailable',
];

/**
 * Narrow a plan to its accepted branch, failing with the refusal reason otherwise.
 * @param plan - The plan.
 * @returns The accepted plan.
 * @throws {Error} When the plan was refused.
 */
function accepted(plan: TimelineEditPlan): Accepted {
  if (!plan.ok) throw new Error(`Expected an accepted plan, got ${plan.reason}`);
  return plan;
}

/**
 * Plan against a deep copy check: the input must be unchanged afterwards.
 * @param current - The document to plan against.
 * @param command - The edit.
 * @param newId - The id factory.
 * @returns The plan.
 * @throws {Error} When planning mutates its input.
 */
function plan(current: TimelineDocumentV1, command: TimelineEditCommand, newId: () => string = idFactory()): TimelineEditPlan {
  const before = structuredClone(current);
  const result = planTimelineEdit(current, command, newId);
  expect(current).toEqual(before);
  return result;
}

/**
 * The refusal reason of a plan, or "ok".
 * @param result - The plan.
 * @returns Its reason.
 * @throws {never} Never.
 */
function reasonOf(result: TimelineEditPlan): string {
  return result.ok ? 'ok' : result.reason;
}

const move = (clipId: string, startFrame: number, placement: TimelineEditPlacement, target: { trackId?: string; newTrackId?: string } = {}): TimelineEditCommand =>
  ({ operation: 'move', parameters: { clipId, startFrame, ...target }, placement });
const setRange = (clipId: string, startFrame: number, sourceInFrame: number, durationFrames: number, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'set_range', parameters: { clipId, startFrame, sourceInFrame, durationFrames }, placement });
const split = (clipId: string, frame: number, newClipId: string, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'split', parameters: { clipId, frame, newClipId }, placement });
const duplicate = (clipId: string, newClipId: string, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'duplicate', parameters: { clipId, newClipId }, placement });
const remove = (clipId: string, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'delete', parameters: { clipId }, placement });
const deleteTrack = (trackId: string, placement: TimelineEditPlacement = ON): TimelineEditCommand =>
  ({ operation: 'delete_track', parameters: { trackId }, placement });
const addVideo = (added: TimelineVideoClip, placement: TimelineEditPlacement, newTrackId?: string, source = SOURCE): TimelineEditCommand =>
  ({ operation: 'add_video', parameters: { source, clip: added, ...(newTrackId === undefined ? {} : { newTrackId }) }, placement });

// The model check's base document: a, b, c packed on the main track and o on v2 attached to b.
const A = cid(1);
const B = cid(2);
const C = cid(3);
const O = cid(4);
const D = cid(5);
const base = timeline([
  clip(A, MAIN, 0, 48),
  clip(B, MAIN, 48, 24),
  clip(C, MAIN, 72, 48),
  clip(O, V2, 50, 10),
]);

describe('Timeline edit command schema', () => {
  it('names the seeded visual track as the main track', () => {
    expect(TIMELINE_MAIN_TRACK_ID).toBe('visual-1');
  });

  it('accepts one strict command per operation with a placement', () => {
    for (const command of [
      addVideo(clip(D, MAIN, 0, 10), ON),
      addVideo(clip(D, MAIN, 0, 10), ON, 'fresh-track'),
      move(A, 10, ON),
      move(A, 10, ON, { trackId: V2 }),
      move(A, 10, OFF, { newTrackId: V3 }),
      setRange(A, 0, 0, 10, MAGNET_ONLY),
      split(A, 10, D, LINK_ONLY),
      duplicate(A, D, ON),
      remove(A, ON),
      deleteTrack(V2),
    ]) expect(TimelineEditCommandSchema.safeParse(command).success).toBe(true);
  });

  it('rejects the removed set_start, a missing placement, extra keys and a move naming two targets', () => {
    expect(TimelineEditCommandSchema.safeParse({ operation: 'set_start', parameters: { clipId: A, startFrame: 0 }, placement: ON }).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse({ operation: 'delete', parameters: { clipId: A } }).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse({ ...remove(A, ON), extra: true }).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse({ operation: 'delete', parameters: { clipId: A }, placement: { ...ON, snap: true } }).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse(move(A, 0, ON, { trackId: V2, newTrackId: V3 })).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse(split(A, 10, 'not-a-uuid', ON)).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse(move(A, 0, ON, { trackId: '' })).success).toBe(false);
    expect(TimelineEditCommandSchema.safeParse(move(A, 0, ON, { newTrackId: 'x'.repeat(65) })).success).toBe(false);
  });
});

describe('timelineSourceOverflow', () => {
  it.each([
    [0, 48, 0],
    [952, 48, 0],
    [990, 48, 38],
    [950, 100, 50],
    [1100, 10, 10],
  ])('counts frames outside the source for in-point %i and duration %i as %i', (sourceInFrame, durationFrames, expected) => {
    expect(timelineSourceOverflow(clip(A, V2, 0, durationFrames, { sourceInFrame }), SOURCE, FPS)).toBe(expected);
  });

  it('samples the source at the clip rate', () => {
    // Frame j samples source frame 900 + 2j; j >= 50 falls at or past 1000.
    expect(timelineSourceOverflow(clip(A, V2, 0, 100, { sourceInFrame: 900, rate: { num: 2, den: 1 } }), SOURCE, FPS)).toBe(50);
  });

  describe('when the source timebase differs from the Timeline rate (inner#1708 Q1)', () => {
    const FPS25 = { num: 25, den: 1 };
    /** 2 s at 50 frames per second: ceil(2 * 50) = 100 source frames. */
    const SOURCE50 = { ...SOURCE, timebase: { num: 50, den: 1 }, extentFrames: 100, durationSeconds: '2' };

    it('counts Timeline frames past the source end in seconds, not in source frames', () => {
      // 100 Timeline frames at 25 fps last 4 s; only the first 50 fall inside the 2 s source.
      expect(timelineSourceOverflow(clip(A, V2, 0, 100), SOURCE50, FPS25)).toBe(50);
      expect(validateTimelineRange(clip(A, V2, 0, 100), SOURCE50, FPS25).valid).toBe(false);
      expect(timelineSourceOverflow(clip(A, V2, 0, 50), SOURCE50, FPS25)).toBe(0);
      expect(validateTimelineRange(clip(A, V2, 0, 50), SOURCE50, FPS25).valid).toBe(true);
    });

    it('agrees with validateTimelineRange on every in-point and duration', () => {
      fc.assert(fc.property(
        fc.integer({ min: 0, max: 120 }), fc.integer({ min: 1, max: 120 }), fc.constantFrom({ num: 1, den: 1 }, { num: 2, den: 1 }, { num: 1, den: 2 }),
        (sourceInFrame, durationFrames, rate) => {
          const placed = clip(A, V2, 0, durationFrames, { sourceInFrame, rate });
          expect(timelineSourceOverflow(placed, SOURCE50, FPS25) === 0).toBe(validateTimelineRange(placed, SOURCE50, FPS25).valid);
        },
      ), { numRuns: 400 });
    });

    it('refuses a set_range that runs past the source end', () => {
      const document = TimelineDocumentV1Schema.parse({
        ...timeline([clip(A, MAIN, 0, 10)], [track(MAIN, 0)], [SOURCE50]),
        settings: { width: 1920, height: 1080, fps: FPS25 },
      });
      expect(reasonOf(plan(document, setRange(A, 0, 0, 100, ON)))).toBe('invalid_range');
      expect(reasonOf(plan(document, setRange(A, 0, 0, 50, ON)))).toBe('ok');
    });
  });
});

describe('planTimelineEdit move', () => {
  it('inserts on the magnetic main track and closes the gap; linkage moves the attached overlay', () => {
    const result = accepted(plan(base, move(A, 100, ON)));
    expect(starts(result.next, MAIN)).toEqual([[B, 0, 24], [C, 24, 48], [A, 72, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(2);
    expect(result.removed).toEqual([]);
    expect(result.bumped).toEqual([]);
  });

  it('leaves the overlay in place when linkage is off', () => {
    const result = accepted(plan(base, move(A, 100, MAGNET_ONLY)));
    expect(starts(result.next, MAIN)).toEqual([[B, 0, 24], [C, 24, 48], [A, 72, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(50);
  });

  it('places at the drop frame and overwrites on the main track when the magnet is off', () => {
    const result = accepted(plan(base, move(A, 100, OFF)));
    expect(starts(result.next, MAIN)).toEqual([[B, 48, 24], [C, 72, 28], [A, 100, 48]]);
    expect(result.next.clips[C]?.sourceInFrame).toBe(0);
    expect(result.next.clips[O]?.startFrame).toBe(50);
  });

  it('moves the attached overlay by the same frames for a whole-clip move with the magnet off', () => {
    const result = accepted(plan(base, move(B, 200, LINK_ONLY)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [C, 72, 48], [B, 200, 24]]);
    expect(result.next.clips[O]).toEqual({ ...base.clips[O], startFrame: 202 });
  });

  it('counts a clip whose midpoint is not later than the drop frame as before it', () => {
    // b's midpoint is 60: a drop at 60 goes after b, at 59 before it.
    const after = accepted(plan(base, move(O, 60, MAGNET_ONLY, { trackId: MAIN })));
    expect(starts(after.next, MAIN)).toEqual([[A, 0, 48], [B, 48, 24], [O, 72, 10], [C, 82, 48]]);
    const before = accepted(plan(base, move(O, 59, MAGNET_ONLY, { trackId: MAIN })));
    expect(starts(before.next, MAIN)).toEqual([[A, 0, 48], [O, 48, 10], [B, 58, 24], [C, 82, 48]]);
    expect(starts(before.next, V2)).toEqual([]);
  });

  it('packs the main track when a clip leaves it, without moving clips attached to the one that left', () => {
    const OA = cid(6);
    const current = timeline([clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 24), clip(OA, V2, 10, 5)]);
    const result = accepted(plan(current, move(A, 300, ON, { trackId: V2 })));
    expect(starts(result.next, MAIN)).toEqual([[B, 0, 24]]);
    expect(starts(result.next, V2)).toEqual([[OA, 10, 5], [A, 300, 48]]);
  });

  it('overwrites on a sub track: a covered middle splits the lower clip with a new id and a later in-point', () => {
    const P = cid(21);
    const Q = cid(22);
    const newId = idFactory();
    const current = timeline([clip(P, V2, 0, 100), clip(Q, V2, 200, 10)]);
    const result = accepted(plan(current, move(Q, 40, ON), newId));
    const v2 = starts(result.next, V2);
    expect(v2).toHaveLength(3);
    expect(v2[0]).toEqual([P, 0, 40]);
    expect(v2[1]).toEqual([Q, 40, 10]);
    const tail = v2[2];
    if (tail === undefined) throw new Error('The split tail is missing');
    expect(tail.slice(1)).toEqual([50, 50]);
    expect([P, Q]).not.toContain(tail[0]);
    expect(result.created).toContain(tail[0]);
    expect(result.next.clips[tail[0]]).toEqual({ ...current.clips[P], id: tail[0], startFrame: 50, sourceInFrame: 50, durationFrames: 50 });
  });

  it('overwrites on a sub track: a fully covered clip is removed, a covered head or tail is trimmed', () => {
    const P = cid(21);
    const Q = cid(22);
    const covered = accepted(plan(timeline([clip(P, V2, 10, 5), clip(Q, V2, 200, 30)]), move(Q, 0, ON)));
    expect(covered.removed).toEqual([P]);
    expect(covered.next.clips[P]).toBeUndefined();

    const head = accepted(plan(timeline([clip(P, V2, 50, 100), clip(Q, V2, 200, 30)]), move(Q, 40, ON)));
    expect(head.next.clips[P]).toMatchObject({ startFrame: 70, sourceInFrame: 20, durationFrames: 80 });

    const tail = accepted(plan(timeline([clip(P, V2, 0, 100), clip(Q, V2, 200, 30)]), move(Q, 80, ON)));
    expect(tail.next.clips[P]).toMatchObject({ startFrame: 0, sourceInFrame: 0, durationFrames: 80 });
  });

  it('creates a new top track for a drop on the blank area above the tracks', () => {
    const result = accepted(plan(base, move(C, 10, ON, { newTrackId: V3 })));
    expect(result.next.tracks[V3]).toEqual({ id: V3, kind: 'visual', order: 2 });
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [B, 48, 24]]);
    expect(starts(result.next, V3)).toEqual([[C, 10, 48]]);
    expect(result.created).toEqual([]);
  });

  it('reports a missing clip and a missing target track separately', () => {
    expect(reasonOf(plan(base, move(cid(99), 0, ON)))).toBe('target_missing');
    expect(reasonOf(plan(base, move(A, 0, ON, { trackId: 'gone' })))).toBe('track_missing');
  });

  it('refuses a new track id that already exists', () => {
    expect(reasonOf(plan(base, move(B, 0, ON, { newTrackId: V2 })))).toBe('id_taken');
    expect(reasonOf(plan(base, move(B, 0, ON, { newTrackId: MAIN })))).toBe('id_taken');
  });
});

describe('planTimelineEdit add_video', () => {
  it('inserts on the magnetic main track and ripples later clips and their overlays', () => {
    const result = accepted(plan(base, addVideo(clip(D, MAIN, 50, 10), ON)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [D, 48, 10], [B, 58, 24], [C, 82, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(60);
    expect(result.created).toContain(D);
    expect(result.next.sources).toEqual({ [SOURCE.id]: SOURCE });
  });

  it('does not move overlays without linkage', () => {
    const result = accepted(plan(base, addVideo(clip(D, MAIN, 50, 10), MAGNET_ONLY)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [D, 48, 10], [B, 58, 24], [C, 82, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(50);
  });

  it('places at the drop frame and splits the covered main clip when the magnet is off', () => {
    const result = accepted(plan(base, addVideo(clip(D, MAIN, 50, 10), OFF)));
    const main = starts(result.next, MAIN);
    expect(main.slice(0, 3)).toEqual([[A, 0, 48], [B, 48, 2], [D, 50, 10]]);
    const tail = main[3];
    if (tail === undefined) throw new Error('The split tail is missing');
    expect(tail.slice(1)).toEqual([60, 12]);
    expect(result.next.clips[tail[0]]?.sourceInFrame).toBe(12);
    expect(main[4]).toEqual([C, 72, 48]);
  });

  it('overwrites the head of a sub-track clip', () => {
    const result = accepted(plan(base, addVideo(clip(D, V2, 45, 10), ON)));
    expect(result.next.clips[O]).toMatchObject({ startFrame: 55, sourceInFrame: 5, durationFrames: 5 });
    expect(result.next.clips[D]?.startFrame).toBe(45);
  });

  it('creates the requested new track on top and places the clip on it', () => {
    const result = accepted(plan(base, addVideo(clip(D, MAIN, 7, 10), ON, V3)));
    expect(result.next.tracks[V3]).toEqual({ id: V3, kind: 'visual', order: 2 });
    expect(result.next.clips[D]).toMatchObject({ trackId: V3, startFrame: 7 });
    expect(starts(result.next, MAIN)).toEqual(starts(base, MAIN));
    expect(result.created).toEqual([D]);
  });

  it('adds a new source once and keeps an existing source unchanged', () => {
    const result = accepted(plan(base, addVideo(clip(D, V2, 200, 10, { sourceId: SHORT_SOURCE.id }), ON, undefined, SHORT_SOURCE)));
    expect(result.next.sources).toEqual({ [SOURCE.id]: SOURCE, [SHORT_SOURCE.id]: SHORT_SOURCE });
  });

  it('refuses an explicit range outside the source, a missing track and a taken id', () => {
    expect(reasonOf(plan(base, addVideo(clip(D, V2, 200, 48, { sourceInFrame: 960 }), ON)))).toBe('invalid_range');
    expect(reasonOf(plan(base, addVideo(clip(D, 'gone', 0, 10), ON)))).toBe('track_missing');
    expect(reasonOf(plan(base, addVideo(clip(A, V2, 200, 10), ON)))).toBe('id_taken');
    expect(reasonOf(plan(base, addVideo(clip(D, MAIN, 0, 10), ON, V2)))).toBe('id_taken');
  });
});

describe('planTimelineEdit set_range', () => {
  it('ripples later main clips on a right trim and moves their overlays with linkage', () => {
    const result = accepted(plan(base, setRange(A, 0, 0, 30, ON)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 30], [B, 30, 24], [C, 54, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(32);
  });

  it('ripples without moving overlays when linkage is off', () => {
    const result = accepted(plan(base, setRange(A, 0, 0, 30, MAGNET_ONLY)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 30], [B, 30, 24], [C, 54, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(50);
  });

  it('changes only the trimmed clip when the magnet is off', () => {
    const result = accepted(plan(base, setRange(A, 0, 0, 30, OFF)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 30], [B, 48, 24], [C, 72, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(50);
  });

  it('keeps a left-trimmed main clip at its sequence position and moves its in-point', () => {
    const result = accepted(plan(base, setRange(B, 58, 10, 14, ON)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [B, 48, 14], [C, 62, 48]]);
    expect(result.next.clips[B]?.sourceInFrame).toBe(10);
  });

  it('leaves a gap and keeps the attached overlay when a left trim moves the clip with the magnet off', () => {
    const result = accepted(plan(base, setRange(B, 58, 10, 14, LINK_ONLY)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [B, 58, 14], [C, 72, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(50);
  });

  it('refuses a trim past the source extent without touching the input', () => {
    expect(plan(base, setRange(A, 0, 990, 48, ON))).toEqual({ ok: false, reason: 'invalid_range' });
    expect(reasonOf(plan(base, setRange(C, 72, 960, 48, ON)))).toBe('invalid_range');
  });

  it('refuses a missing target', () => {
    expect(reasonOf(plan(base, setRange(cid(99), 0, 0, 10, ON)))).toBe('target_missing');
  });

  it('moves a linked clip that would land on another clip to the first free track above, creating one when none is free', () => {
    const OA = cid(6);
    const OB = cid(7);
    const current = timeline([clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48), clip(OA, V2, 10, 60), clip(OB, V2, 70, 10)]);
    const newId = idFactory('50000000');
    const result = accepted(plan(current, setRange(A, 0, 0, 20, ON), newId));
    expect(result.next.clips[B]?.startFrame).toBe(20);
    expect(result.next.clips[OA]).toEqual(current.clips[OA]);
    expect(result.next.clips[OB]?.startFrame).toBe(42);
    const bumpedTrack = result.next.clips[OB]?.trackId;
    expect(bumpedTrack).not.toBe(V2);
    expect(bumpedTrack).toMatch(/^50000000-/);
    expect(result.next.tracks[bumpedTrack ?? '']).toEqual({ id: bumpedTrack, kind: 'visual', order: 2 });
    expect(result.bumped).toEqual([OB]);
    expect(result.created).toEqual([]);
  });

  it('skips an occupied track above when bumping a linked clip', () => {
    const OA = cid(6);
    const OB = cid(7);
    const BL = cid(8);
    const current = timeline(
      [clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48), clip(OA, V2, 10, 60), clip(OB, V2, 70, 10), clip(BL, V3, 40, 20)],
      [track(MAIN, 0), track(V2, 1), track(V3, 2), track(V4, 3)],
    );
    const result = accepted(plan(current, setRange(A, 0, 0, 20, ON)));
    expect(result.next.clips[OB]).toMatchObject({ trackId: V4, startFrame: 42 });
    expect(result.next.clips[BL]).toEqual(current.clips[BL]);
    expect(Object.keys(result.next.tracks).sort()).toEqual(Object.keys(current.tracks).sort());
    expect(result.bumped).toEqual([OB]);
  });

  it('bumps a linked clip onto a later track that shares its track\'s order (inner#1708 E3)', () => {
    const OA = cid(6);
    const OB = cid(7);
    const current = timeline(
      [clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48), clip(OA, V2, 10, 60), clip(OB, V2, 70, 10)],
      [track(MAIN, 0), track(V2, 1), track(V3, 1)],
    );
    const result = accepted(plan(current, setRange(A, 0, 0, 20, ON)));
    expect(result.next.clips[OB]).toMatchObject({ trackId: V3, startFrame: 42 });
    expect(Object.keys(result.next.tracks).sort()).toEqual([MAIN, V2, V3].sort());
    expect(result.bumped).toEqual([OB]);
  });

  it('never bumps a linked clip down onto an earlier track that shares its order (inner#1708 E3)', () => {
    const OA = cid(6);
    const OB = cid(7);
    const current = timeline(
      [clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48), clip(OA, V3, 10, 60), clip(OB, V3, 70, 10)],
      [track(MAIN, 0), track(V2, 1), track(V3, 1)],
    );
    const result = accepted(plan(current, setRange(A, 0, 0, 20, ON)));
    const landed = result.next.clips[OB]?.trackId ?? '';
    expect([V2, V3]).not.toContain(landed);
    expect(result.next.tracks[landed]).toMatchObject({ kind: 'visual' });
    expect(result.bumped).toEqual([OB]);
  });

  it('does not bump when linkage is off', () => {
    const OA = cid(6);
    const OB = cid(7);
    const current = timeline([clip(A, MAIN, 0, 48), clip(B, MAIN, 48, 48), clip(OA, V2, 10, 60), clip(OB, V2, 70, 10)]);
    const result = accepted(plan(current, setRange(A, 0, 0, 20, MAGNET_ONLY)));
    expect(result.next.clips[OB]).toEqual(current.clips[OB]);
    expect(result.bumped).toEqual([]);
    expect(Object.keys(result.next.tracks).sort()).toEqual([MAIN, V2].sort());
  });
});

describe('planTimelineEdit split', () => {
  it('keeps the total length and shares the source', () => {
    const A2 = cid(11);
    for (const placement of [ON, OFF]) {
      const result = accepted(plan(base, split(A, 20, A2, placement)));
      expect(starts(result.next, MAIN)).toEqual([[A, 0, 20], [A2, 20, 28], [B, 48, 24], [C, 72, 48]]);
      expect(result.next.clips[A2]).toEqual({ ...base.clips[A], id: A2, startFrame: 20, sourceInFrame: 20, durationFrames: 28 });
      expect(result.created).toContain(A2);
    }
  });

  it('refuses a split on either boundary', () => {
    expect(reasonOf(plan(base, split(A, 48, cid(11), ON)))).toBe('invalid_range');
    expect(reasonOf(plan(base, split(A, 0, cid(11), ON)))).toBe('invalid_range');
  });

  it('refuses a missing target and a taken new id', () => {
    expect(reasonOf(plan(base, split(cid(99), 10, cid(11), ON)))).toBe('target_missing');
    expect(reasonOf(plan(base, split(A, 10, B, ON)))).toBe('id_taken');
  });

  it('packs a magnetic main track that holds a merged overlap or a gap', () => {
    const A2 = cid(11);
    const current = timeline([clip(A, MAIN, 0, 100), clip(B, MAIN, 50, 100), clip(C, MAIN, 400, 10)]);
    const result = accepted(plan(current, split(A, 80, A2, ON)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 80], [B, 80, 100], [A2, 180, 20], [C, 200, 10]]);
  });

  it('refuses a split whose source offset is not a whole frame at the clip rate', () => {
    const R = cid(12);
    const half = timeline([clip(R, V2, 0, 100, { rate: { num: 1, den: 2 } })]);
    expect(reasonOf(plan(half, split(R, 31, cid(13), ON)))).toBe('invalid_range');
    const even = accepted(plan(half, split(R, 30, cid(13), ON)));
    expect(even.next.clips[cid(13)]).toMatchObject({ startFrame: 30, sourceInFrame: 15, durationFrames: 70, rate: { num: 1, den: 2 } });
    const double = timeline([clip(R, V2, 0, 100, { rate: { num: 2, den: 1 } })]);
    expect(accepted(plan(double, split(R, 31, cid(13), ON))).next.clips[cid(13)]).toMatchObject({ sourceInFrame: 62, durationFrames: 69 });
  });
});

describe('planTimelineEdit duplicate', () => {
  const B2 = cid(14);

  it('inserts right after the original on the magnetic main track', () => {
    const result = accepted(plan(base, duplicate(B, B2, ON)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [B, 48, 24], [B2, 72, 24], [C, 96, 48]]);
    expect(result.next.clips[B2]).toEqual({ ...base.clips[B], id: B2, startFrame: 72 });
    expect(result.created).toEqual([B2]);
  });

  it('ripples overlays attached to later main clips with linkage', () => {
    const A2 = cid(11);
    expect(accepted(plan(base, duplicate(A, A2, ON))).next.clips[O]?.startFrame).toBe(98);
    expect(accepted(plan(base, duplicate(A, A2, MAGNET_ONLY))).next.clips[O]?.startFrame).toBe(50);
  });

  it('places at the original\'s end and overwrites when the magnet is off', () => {
    const result = accepted(plan(base, duplicate(B, B2, OFF)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [B, 48, 24], [B2, 72, 24], [C, 96, 24]]);
    expect(result.next.clips[C]?.sourceInFrame).toBe(24);
  });

  it('places at the original\'s end on a sub track', () => {
    const O2 = cid(15);
    const result = accepted(plan(base, duplicate(O, O2, ON)));
    expect(starts(result.next, V2)).toEqual([[O, 50, 10], [O2, 60, 10]]);
  });

  it('refuses a missing target and a taken new id', () => {
    expect(reasonOf(plan(base, duplicate(cid(99), B2, ON)))).toBe('target_missing');
    expect(reasonOf(plan(base, duplicate(B, A, ON)))).toBe('id_taken');
  });
});

describe('planTimelineEdit delete', () => {
  it('closes the gap on the magnetic main track and deletes the linked overlay with its anchor', () => {
    const result = accepted(plan(base, remove(B, ON)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [C, 48, 48]]);
    expect(result.next.clips[O]).toBeUndefined();
    expect([...result.removed].sort()).toEqual([B, O].sort());
    expect(result.next.sources).toEqual(base.sources);
  });

  it('keeps the overlay without linkage', () => {
    const result = accepted(plan(base, remove(B, MAGNET_ONLY)));
    expect(starts(result.next, MAIN)).toEqual([[A, 0, 48], [C, 48, 48]]);
    expect(result.next.clips[O]?.startFrame).toBe(50);
    expect(result.removed).toEqual([B]);
  });

  it('leaves a gap with the magnet off and still deletes a linked overlay', () => {
    const off = accepted(plan(base, remove(B, OFF)));
    expect(starts(off.next, MAIN)).toEqual([[A, 0, 48], [C, 72, 48]]);
    expect(off.next.clips[O]?.startFrame).toBe(50);
    const linked = accepted(plan(base, remove(B, LINK_ONLY)));
    expect(starts(linked.next, MAIN)).toEqual([[A, 0, 48], [C, 72, 48]]);
    expect(linked.next.clips[O]).toBeUndefined();
  });

  it('refuses a missing target', () => {
    expect(reasonOf(plan(base, remove(cid(99), ON)))).toBe('target_missing');
  });
});

describe('planTimelineEdit delete_track', () => {
  it('deletes an empty sub track and refuses the main, a non-empty and a missing track', () => {
    const empty = timeline([]);
    const result = accepted(plan(empty, deleteTrack(V2)));
    expect(Object.keys(result.next.tracks)).toEqual([MAIN]);
    expect(reasonOf(plan(empty, deleteTrack(MAIN)))).toBe('main_track');
    expect(reasonOf(plan(base, deleteTrack(V2)))).toBe('track_not_empty');
    expect(reasonOf(plan(base, deleteTrack('gone')))).toBe('track_missing');
  });
});

describe('planTimelineEdit source availability', () => {
  const MISSING_SOURCE_ID = '10000000-0000-4000-8000-000000000009';
  const Z = cid(51);
  const sourceless = timeline([clip(Z, V2, 0, 10, { sourceId: MISSING_SOURCE_ID }), clip(A, MAIN, 0, 48)]);

  it('refuses an addition whose clip names neither the supplied source nor an existing one', () => {
    expect(reasonOf(plan(base, addVideo(clip(D, V2, 200, 10, { sourceId: MISSING_SOURCE_ID }), ON)))).toBe('source_unavailable');
    expect(reasonOf(plan(base, addVideo(clip(D, V2, 200, 10, { sourceId: MISSING_SOURCE_ID }), ON, undefined, SHORT_SOURCE)))).toBe('source_unavailable');
  });

  it('refuses editing a clip whose source is absent from the document', () => {
    for (const placement of [ON, OFF]) {
      expect(reasonOf(plan(sourceless, move(Z, 100, placement)))).toBe('source_unavailable');
      expect(reasonOf(plan(sourceless, move(Z, 100, placement, { trackId: MAIN })))).toBe('source_unavailable');
      expect(reasonOf(plan(sourceless, setRange(Z, 0, 0, 5, placement)))).toBe('source_unavailable');
      expect(reasonOf(plan(sourceless, split(Z, 5, cid(52), placement)))).toBe('source_unavailable');
      expect(reasonOf(plan(sourceless, duplicate(Z, cid(53), placement)))).toBe('source_unavailable');
    }
  });

  it('still edits other clips of a document that holds a sourceless clip', () => {
    expect(plan(sourceless, setRange(A, 0, 0, 30, ON)).ok).toBe(true);
  });
});

describe('planTimelineEdit on documents holding merged conflicts', () => {
  const P = cid(21);
  const Q = cid(22);
  const S = cid(23);
  const merged = timeline([clip(P, V2, 0, 100), clip(Q, V2, 50, 100), clip(S, V2, 300, 10)]);

  it('does not let a merged overlap block an unrelated overwrite on the same track', () => {
    const result = accepted(plan(merged, move(S, 20, ON)));
    expect(overlapSpans(result.next, V2)).toEqual([[50, 100]]);
  });

  it('allows splitting a clip inside the merged overlap', () => {
    expect(plan(merged, split(P, 70, cid(24), ON)).ok).toBe(true);
  });

  it('adds no overlapped frames when moving into the merged region', () => {
    const result = accepted(plan(merged, move(S, 120, ON)));
    expect(overlapSpans(result.next, V2)).toEqual([[50, 100]]);
  });

  const X = cid(25);
  const Y = cid(26);
  const outOfRange = timeline([clip(X, V2, 0, 100, { sourceInFrame: 950 }), clip(Y, V2, 300, 10)]);

  it('does not let an out-of-source clip block unrelated edits or its own move', () => {
    expect(plan(outOfRange, move(Y, 200, ON)).ok).toBe(true);
    expect(plan(outOfRange, move(X, 400, ON)).ok).toBe(true);
  });

  it('never makes an out-of-source clip worse and requires an explicit range to be valid', () => {
    expect(reasonOf(plan(outOfRange, setRange(X, 0, 950, 400, ON)))).toBe('invalid_range');
    expect(reasonOf(plan(outOfRange, setRange(X, 0, 950, 80, ON)))).toBe('invalid_range');
    expect(plan(outOfRange, setRange(X, 0, 900, 100, ON)).ok).toBe(true);
  });

  it('allows covering the middle of an out-of-source clip or splitting it, keeping its overflow; refuses duplicating it', () => {
    const covered = accepted(plan(outOfRange, move(Y, 20, ON)));
    expect(totalOverflow(covered.next)).toBe(totalOverflow(outOfRange));
    const cut = accepted(plan(outOfRange, split(X, 30, cid(27), ON)));
    expect(totalOverflow(cut.next)).toBe(totalOverflow(outOfRange));
    expect(reasonOf(plan(outOfRange, duplicate(X, cid(28), ON)))).toBe('invalid_range');
  });

  const orphanId = cid(31);
  const orphan = timeline([clip(orphanId, 'gone', 0, 10)]);

  it('lets a clip whose track was removed be deleted, trimmed, split and moved to an existing track', () => {
    expect(plan(orphan, remove(orphanId, ON)).ok).toBe(true);
    expect(plan(orphan, setRange(orphanId, 0, 0, 5, ON)).ok).toBe(true);
    expect(plan(orphan, split(orphanId, 5, cid(32), ON)).ok).toBe(true);
    expect(accepted(plan(orphan, move(orphanId, 0, ON, { trackId: V2 }))).next.clips[orphanId]?.trackId).toBe(V2);
  });

  it('refuses placing a clip on its removed track', () => {
    expect(reasonOf(plan(orphan, duplicate(orphanId, cid(33), ON)))).toBe('track_missing');
    expect(reasonOf(plan(orphan, move(orphanId, 20, ON)))).toBe('track_missing');
  });
});

describe('planTimelineEdit linkage after packing', () => {
  const M = cid(41);
  const OV = cid(42);
  const current = timeline([clip(A, MAIN, 0, 10), clip(M, MAIN, 30, 40), clip(OV, V2, 60, 5)]);

  it('follows a split main clip that packing moved', () => {
    expect(accepted(plan(current, split(M, 50, cid(43), ON))).next.clips[OV]?.startFrame).toBe(40);
    expect(accepted(plan(current, split(M, 50, cid(43), MAGNET_ONLY))).next.clips[OV]?.startFrame).toBe(60);
  });

  it('follows a trimmed main clip that packing moved', () => {
    expect(accepted(plan(current, setRange(M, 30, 0, 35, ON))).next.clips[OV]?.startFrame).toBe(40);
  });

  it('stays when the trimmed clip moved only because of its own trim', () => {
    expect(accepted(plan(current, setRange(M, 35, 5, 35, LINK_ONLY))).next.clips[OV]?.startFrame).toBe(60);
  });
});

describe('planTimelineEdit invariants over random documents', () => {
  const TRACK_CHOICES = [MAIN, MAIN, V2, V2, V3, 'gone'];
  const clipArbitrary = fc.record({
    track: fc.integer({ min: 0, max: TRACK_CHOICES.length - 1 }),
    startFrame: fc.integer({ min: 0, max: 300 }),
    durationFrames: fc.integer({ min: 1, max: 80 }),
    sourceInFrame: fc.oneof(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 900, max: 990 })),
  });
  const commandArbitrary = fc.record({
    operation: fc.integer({ min: 0, max: 6 }),
    pick: fc.nat(),
    frame: fc.integer({ min: 0, max: 400 }),
    inPoint: fc.integer({ min: 0, max: 60 }),
    length: fc.integer({ min: 1, max: 80 }),
    target: fc.integer({ min: 0, max: 4 }),
    magnet: fc.boolean(),
    linkage: fc.boolean(),
    reuseId: fc.integer({ min: 0, max: 19 }),
  });
  type CommandSeed = typeof commandArbitrary extends fc.Arbitrary<infer T> ? T : never;

  /**
   * Build one command from random parameters against the current document.
   * @param current - The document.
   * @param seed - The random parameters.
   * @param fresh - The id factory for command ids.
   * @returns The command and whether it touches the main track.
   * @throws {never} Never.
   */
  function buildCommand(current: TimelineDocumentV1, seed: CommandSeed, fresh: () => string): { command: TimelineEditCommand; touchesMain: boolean } {
    const placement = { magnet: seed.magnet, linkage: seed.linkage };
    const ids = Object.keys(current.clips).sort();
    const subjectId = ids.length === 0 ? cid(99) : ids[seed.pick % ids.length] ?? cid(99);
    const subject = current.clips[subjectId];
    const onMain = subject?.trackId === MAIN;
    // One edit in twenty reuses an existing id to exercise id_taken.
    const newClipId = seed.reuseId === 0 && ids.length > 0 ? subjectId : fresh();
    const target = [{}, { trackId: MAIN }, { trackId: V2 }, { newTrackId: seed.reuseId === 1 ? V2 : fresh() }, { trackId: V3 }][seed.target] ?? {};
    switch (seed.operation) {
      case 0: {
        const added = clip(fresh(), 'trackId' in target && target.trackId !== undefined ? target.trackId : MAIN, seed.frame, seed.length, { sourceInFrame: seed.inPoint });
        const newTrackId = 'newTrackId' in target ? target.newTrackId : undefined;
        return { command: addVideo(added, placement, newTrackId), touchesMain: added.trackId === MAIN && newTrackId === undefined };
      }
      case 1: return { command: move(subjectId, seed.frame, placement, target), touchesMain: onMain || ('trackId' in target && target.trackId === MAIN) };
      case 2: return {
        command: setRange(subjectId, (subject?.startFrame ?? 0) + (seed.frame % 10), seed.inPoint, seed.length, placement),
        touchesMain: onMain,
      };
      case 3: return {
        command: split(subjectId, (subject?.startFrame ?? 0) + (seed.frame % ((subject?.durationFrames ?? 0) + 1)), newClipId, placement),
        touchesMain: onMain,
      };
      case 4: return { command: duplicate(subjectId, newClipId, placement), touchesMain: onMain };
      case 5: return { command: remove(subjectId, placement), touchesMain: onMain };
      default: return { command: deleteTrack([V2, V3, MAIN, 'gone'][seed.pick % 4] ?? V2, placement), touchesMain: false };
    }
  }

  /**
   * Check every invariant of one accepted plan.
   * @param before - The planned-against document.
   * @param command - The edit.
   * @param touchesMain - Whether the edit involves the main track.
   * @param result - The accepted plan.
   * @throws {Error} When an invariant fails.
   */
  function checkAccepted(before: TimelineDocumentV1, command: TimelineEditCommand, touchesMain: boolean, result: Accepted): void {
    const next = result.next;
    expect(TimelineDocumentV1Schema.safeParse(next).success).toBe(true);
    expect(next.settings).toEqual(before.settings);
    // The planner leaves sources to the writer (inner#1708 Q1): the current ones, plus an added source it does not hold.
    const added = command.operation === 'add_video' && before.sources[command.parameters.source.id] === undefined
      ? { [command.parameters.source.id]: command.parameters.source } : {};
    expect(next.sources).toEqual({ ...before.sources, ...added });

    // No new overlapped frames on any track.
    const overlapBefore = overlappedFrames(before);
    for (const frame of overlappedFrames(next)) expect(overlapBefore.has(frame), `new overlapped frame ${frame}`).toBe(true);

    // Out-of-source frames never grow, and a clip valid before stays valid.
    expect(totalOverflow(next)).toBeLessThanOrEqual(totalOverflow(before));
    for (const item of Object.values(next.clips)) {
      const was = before.clips[item.id];
      const source = next.sources[item.sourceId];
      if (was === undefined || source === undefined) continue;
      if (referenceOverflow(was, source) === 0) expect(referenceOverflow(item, source), `clip ${item.id} became invalid`).toBe(0);
    }

    // Main track packed from frame 0 after a magnetic edit that involves it.
    if (command.placement.magnet && touchesMain) {
      let at = 0;
      for (const [, startFrame, durationFrames] of starts(next, MAIN)) {
        expect(startFrame).toBe(at);
        at += durationFrames;
      }
    }

    // Splitting preserves the covered duration.
    if (command.operation === 'split') {
      const sum = (document: TimelineDocumentV1): number => Object.values(document.clips).reduce((total, item) => total + item.durationFrames, 0);
      expect(sum(next)).toBe(sum(before));
      const original = before.clips[command.parameters.clipId];
      expect((next.clips[command.parameters.clipId]?.durationFrames ?? 0) + (next.clips[command.parameters.newClipId]?.durationFrames ?? 0))
        .toBe(original?.durationFrames);
    }

    // Created ids are unique, new, and cover every new clip; removed lists every vanished clip.
    expect(new Set(result.created).size).toBe(result.created.length);
    for (const id of result.created) {
      expect(before.clips[id]).toBeUndefined();
      expect(before.tracks[id]).toBeUndefined();
      // created holds clip ids only; new tracks are not listed.
      expect(next.clips[id]).toBeDefined();
      expect(next.tracks[id]).toBeUndefined();
    }
    for (const id of Object.keys(next.clips)) if (before.clips[id] === undefined) expect(result.created).toContain(id);
    expect([...result.removed].sort()).toEqual(Object.keys(before.clips).filter((id) => next.clips[id] === undefined).sort());
    for (const id of result.bumped) expect(next.clips[id]?.trackId).not.toBe(before.clips[id]?.trackId);
  }

  it('keeps every invariant across random edit sequences, including merged overlaps and out-of-source starts', () => {
    let acceptedCount = 0;
    fc.assert(fc.property(
      fc.array(clipArbitrary, { maxLength: 7 }),
      fc.boolean(),
      fc.array(commandArbitrary, { minLength: 1, maxLength: 6 }),
      (clipSeeds, withV3, commandSeeds) => {
        const tracks = withV3 ? [track(MAIN, 0), track(V2, 1), track(V3, 2)] : [track(MAIN, 0), track(V2, 1)];
        let current = timeline(
          clipSeeds.map((seed, index) => clip(cid(index + 1), TRACK_CHOICES[seed.track] ?? MAIN, seed.startFrame, seed.durationFrames, { sourceInFrame: seed.sourceInFrame })),
          tracks,
        );
        const fresh = idFactory('60000000');
        const newId = idFactory('70000000');
        for (const seed of commandSeeds) {
          const { command, touchesMain } = buildCommand(current, seed, fresh);
          const result = plan(current, command, newId);
          if (!result.ok) {
            expect(REASONS).toContain(result.reason);
            continue;
          }
          acceptedCount += 1;
          checkAccepted(current, command, touchesMain, result);
          current = result.next;
        }
      },
    ), { numRuns: 400 });
    expect(acceptedCount).toBeGreaterThan(400);
  });
});

describe('planTimelineEdit leaves sources to the writer (inner#1708 Q1)', () => {
  const X = cid(31);
  const W = cid(33);

  it('keeps the source of a deleted last clip in the plan', () => {
    const current = timeline([clip(A, MAIN, 0, 48), clip(X, V2, 100, 20, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]);
    expect(accepted(plan(current, remove(X, OFF))).next.sources).toEqual(current.sources);
  });

  it('keeps a source no clip referenced before the edit', () => {
    const current = timeline([clip(A, MAIN, 0, 48)], undefined, [SOURCE, SHORT_SOURCE]);
    expect(accepted(plan(current, move(A, 0, OFF, { trackId: V2 }))).next.sources).toEqual(current.sources);
  });

  it('keeps the source of a clip an overwrite removes', () => {
    const current = timeline([clip(A, MAIN, 0, 48), clip(W, V2, 10, 20, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]);
    const result = accepted(plan(current, move(A, 0, OFF, { trackId: V2 })));
    expect(result.removed).toEqual([W]);
    expect(result.next.sources).toEqual(current.sources);
  });

  it('adds a new source and keeps a stored one unchanged for every kind of edit', () => {
    const current = timeline([clip(A, MAIN, 0, 48), clip(X, V2, 100, 20, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]);
    const fresh = { ...SOURCE, id: '10000000-0000-4000-8000-000000000099', assetId: '20000000-0000-4000-8000-000000000099' };
    for (const command of [
      split(A, 10, cid(40), ON), duplicate(X, cid(41), OFF), remove(A, ON), move(X, 300, OFF), setRange(X, 100, 0, 10, OFF),
      addVideo(clip(cid(42), V2, 400, 10), OFF),
    ]) expect(accepted(plan(current, command)).next.sources, command.operation).toEqual(current.sources);
    expect(accepted(plan(current, addVideo(clip(cid(43), V2, 400, 10, { sourceId: fresh.id }), OFF, undefined, fresh))).next.sources)
      .toEqual({ ...current.sources, [fresh.id]: fresh });
  });
});
