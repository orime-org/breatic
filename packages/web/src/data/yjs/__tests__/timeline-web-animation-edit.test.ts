// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web-animation copies in the Timeline planner (inner#1711 design §3.2–§3.3, V5).
 *
 * A copy's length is not in the document: `resolveTimelineClipExtent(document, web, clip)` reads it from the
 * `TimelineWebResolution` the web-sources endpoint answers, and every planner rule that reads a video's source length
 * reads that instead. `add_web_animation` and `land_execution` carry the new reference's extent themselves, the way
 * `add_video` carries its source, and place the copy with `placeWebAnimationClip`: above the highest video over its
 * span, or on a new top track.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  resolveTimelineArrangement, resolveTimelineClipExtent,
} from '@web/data/yjs/timeline-arrangement';
import { TimelineEditCommandSchema, planTimelineEdit, type TimelineEditCommand, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import type { TimelineDocumentV1, TimelineWebAnimationClip } from '@breatic/shared';
import {
  FPS, LINK_ONLY, MAIN, OFF, SOURCE, V2, V3, V4, cid, clip, idFactory, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  EMPTY_RESOLUTION, EXEC_CANCELLED, EXEC_DONE, EXEC_EXPIRED, EXEC_FAILED, EXEC_GONE, EXEC_RUNNING, RESOLUTION, SRC_A, SRC_B, SRC_GONE,
  addPlaceholder, addResult, boundTo, land, waitingFor, webClip,
} from '@web/data/yjs/__tests__/timeline-web-fixtures';

type Accepted = Extract<TimelineEditPlan, { ok: true }>;

const NEW_TRACK = 'track-new';
const RECEIPT = { executionId: EXEC_RUNNING, inputHash: 'sha256:abc', landedAt: '2026-11-07T08:00:00.000Z' };
const ACTION = 'a0000000-0000-4000-8000-000000000001';

/**
 * Plan with the web resolution, checking the input is left as it was.
 * @param current - The document.
 * @param command - The edit.
 * @param web - The resolution of the document's web references.
 * @returns The plan.
 * @throws {Error} When planning mutates its input.
 */
function plan(current: TimelineDocumentV1, command: TimelineEditCommand, web = RESOLUTION): TimelineEditPlan {
  const before = structuredClone(current);
  const result = planTimelineEdit(current, command, idFactory(), web);
  expect(current).toEqual(before);
  return result;
}

/**
 * Narrow a plan to its accepted branch.
 * @param result - The plan.
 * @returns The accepted plan.
 * @throws {Error} When the plan was refused.
 */
function accepted(result: TimelineEditPlan): Accepted {
  if (!result.ok) throw new Error(`Expected an accepted plan, got ${result.reason}`);
  return result;
}

/**
 * The one clip a plan created.
 * @param result - The accepted plan.
 * @param id - The created id.
 * @returns The created web copy.
 * @throws {Error} When the plan did not create it as a web copy.
 */
function createdCopy(result: Accepted, id: string): TimelineWebAnimationClip {
  const created = result.next.clips[id];
  if (created?.kind !== 'web-animation') throw new Error(`Expected web copy ${id}, got ${JSON.stringify(created)}`);
  return created;
}

const move = (clipId: string, startFrame: number, target: { trackId?: string } = {}): TimelineEditCommand =>
  ({ operation: 'move', parameters: { clipId, startFrame, ...target }, placement: OFF });
const moveLinked = (clipId: string, startFrame: number): TimelineEditCommand =>
  ({ operation: 'move', parameters: { clipId, startFrame }, placement: LINK_ONLY });
const setRange = (clipId: string, startFrame: number, sourceInFrame: number, durationFrames: number): TimelineEditCommand =>
  ({ operation: 'set_range', parameters: { clipId, startFrame, sourceInFrame, durationFrames }, placement: OFF });

describe('resolveTimelineClipExtent', () => {
  const doc = timeline([clip(cid(1), MAIN, 0, 100)]);

  it('reads a video from the document sources', () => {
    const video = clip(cid(1), MAIN, 0, 100);
    expect(resolveTimelineClipExtent(doc, RESOLUTION, video)).toMatchObject({ extentFrames: SOURCE.extentFrames, timebase: SOURCE.timebase });
  });

  it('reads a copy bound to a source version from that version', () => {
    expect(resolveTimelineClipExtent(doc, RESOLUTION, webClip(cid(2), V2, 0, 10, boundTo(SRC_A)))).toMatchObject({ extentFrames: 48, timebase: FPS });
  });

  it('reads a placeholder of a succeeded execution from its result', () => {
    expect(resolveTimelineClipExtent(doc, RESOLUTION, webClip(cid(2), V2, 0, 10, waitingFor(EXEC_DONE)))).toMatchObject({ extentFrames: 96, timebase: FPS });
  });

  it.each([
    ['running', EXEC_RUNNING, 72],
    ['failed', EXEC_FAILED, 48],
    ['cancelled', EXEC_CANCELLED, 24],
    ['expired', EXEC_EXPIRED, 24],
  ])('reads a placeholder of a %s execution from its accepted duration', (_status, executionId, frames) => {
    expect(resolveTimelineClipExtent(doc, RESOLUTION, webClip(cid(2), V2, 0, 10, waitingFor(executionId)))).toMatchObject({ extentFrames: frames, timebase: FPS });
  });

  it('leaves a reference the resolution did not return unresolved', () => {
    expect(resolveTimelineClipExtent(doc, RESOLUTION, webClip(cid(2), V2, 0, 10, boundTo(SRC_GONE)))).toBeUndefined();
    expect(resolveTimelineClipExtent(doc, RESOLUTION, webClip(cid(3), V2, 0, 10, waitingFor(EXEC_GONE)))).toBeUndefined();
  });
});

describe('resolveTimelineArrangement with web copies', () => {
  it('counts a copy inside its resolved source as ready', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 48, boundTo(SRC_A)), webClip(cid(2), V2, 100, 72, waitingFor(EXEC_RUNNING))]);
    expect(resolveTimelineArrangement(doc, RESOLUTION).readyClipIds).toEqual([cid(1), cid(2)]);
  });

  it('reports a copy that reads past its source end as invalid_range', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 40, boundTo(SRC_A), { sourceInFrame: 10 })]);
    const arrangement = resolveTimelineArrangement(doc, RESOLUTION);
    expect(arrangement.readyClipIds).toEqual([]);
    expect(arrangement.conflicts[0]?.reasons.map((reason) => reason.code)).toContain('invalid_range');
  });

  it('keeps an unresolved copy out of the ready set', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 10, boundTo(SRC_GONE))]);
    expect(resolveTimelineArrangement(doc, RESOLUTION).readyClipIds).toEqual([]);
    expect(resolveTimelineArrangement(doc, EMPTY_RESOLUTION).readyClipIds).toEqual([]);
  });
});

describe('inner#1708 commands on web copies', () => {
  it('moves a copy and checks its range against the resolved source', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 48)]);
    expect(accepted(plan(doc, move(cid(1), 30))).next.clips[cid(1)]).toMatchObject({ startFrame: 30, contentBinding: boundTo(SRC_A) });
  });

  it('lets a range reach the source end and refuses one past it', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 24)]);
    expect(accepted(plan(doc, setRange(cid(1), 0, 24, 24))).next.clips[cid(1)]).toMatchObject({ sourceInFrame: 24, durationFrames: 24 });
    const refused = plan(doc, setRange(cid(1), 0, 24, 25));
    expect(refused.ok ? 'ok' : refused.reason).toBe('invalid_range');
  });

  it('plans a placeholder of a failed execution by its accepted length', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 24, waitingFor(EXEC_FAILED))]);
    expect(plan(doc, setRange(cid(1), 0, 0, 48)).ok).toBe(true);
    const refused = plan(doc, setRange(cid(1), 0, 0, 49));
    expect(refused.ok ? 'ok' : refused.reason).toBe('invalid_range');
  });

  it('refuses a length-dependent edit of an unresolved copy with source_unresolved, and still deletes it', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 24, boundTo(SRC_GONE))]);
    const refused = plan(doc, setRange(cid(1), 0, 0, 12));
    expect(refused.ok ? 'ok' : refused.reason).toBe('source_unresolved');
    expect(accepted(plan(doc, { operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF })).next.clips[cid(1)]).toBeUndefined();
  });

  it('splits a copy into two halves with the same binding, the right one reading on from the cut', () => {
    const doc = timeline([webClip(cid(1), V2, 10, 40, boundTo(SRC_A), { sourceInFrame: 4 })]);
    const result = accepted(plan(doc, { operation: 'split', parameters: { clipId: cid(1), frame: 25, newClipId: cid(2) }, placement: OFF }));
    expect(result.next.clips[cid(1)]).toMatchObject({ startFrame: 10, sourceInFrame: 4, durationFrames: 15, contentBinding: boundTo(SRC_A) });
    expect(result.next.clips[cid(2)]).toMatchObject({ kind: 'web-animation', startFrame: 25, sourceInFrame: 19, durationFrames: 25, contentBinding: boundTo(SRC_A) });
  });

  it('duplicates a copy under a new id with the same binding', () => {
    const doc = timeline([webClip(cid(1), V2, 0, 20, waitingFor(EXEC_RUNNING))]);
    const result = accepted(plan(doc, { operation: 'duplicate', parameters: { clipId: cid(1), newClipId: cid(2) }, placement: OFF }));
    expect(result.next.clips[cid(2)]).toMatchObject({ kind: 'web-animation', startFrame: 20, durationFrames: 20, contentBinding: waitingFor(EXEC_RUNNING) });
    expect(result.next.clips[cid(1)]).toEqual(doc.clips[cid(1)]);
  });

  it('trims a copy whose head a video covers, advancing its in-point by the resolved source', () => {
    const doc = timeline([webClip(cid(1), V2, 20, 40), clip(cid(2), V2, 100, 10)]);
    const result = accepted(plan(doc, move(cid(2), 10)));
    expect(result.next.clips[cid(1)]).toMatchObject({ startFrame: 20, sourceInFrame: 0, durationFrames: 40 });
    const covering = accepted(plan(doc, move(cid(2), 15)));
    expect(covering.next.clips[cid(1)]).toMatchObject({ startFrame: 25, sourceInFrame: 5, durationFrames: 35 });
  });

  it('lets a video overwrite the head of a failed placeholder, reading on by its accepted length', () => {
    const doc = timeline([webClip(cid(1), V2, 10, 48, waitingFor(EXEC_FAILED)), clip(cid(2), V3, 0, 20)], [track(MAIN, 0), track(V2, 1), track(V3, 2)]);
    const result = accepted(plan(doc, move(cid(2), 0, { trackId: V2 })));
    expect(result.next.clips[cid(1)]).toMatchObject({ startFrame: 20, sourceInFrame: 10, durationFrames: 38 });
  });

  it('carries a copy attached to a main clip when linkage moves that clip, and removes it with that clip', () => {
    const doc = timeline([clip(cid(1), MAIN, 0, 100), webClip(cid(2), V2, 10, 24)]);
    expect(accepted(plan(doc, moveLinked(cid(1), 50))).next.clips[cid(2)]).toMatchObject({ trackId: V2, startFrame: 60 });
    const removed = accepted(plan(doc, { operation: 'delete', parameters: { clipId: cid(1) }, placement: LINK_ONLY }));
    expect(removed.next.clips[cid(2)]).toBeUndefined();
  });
});

describe('add_web_animation', () => {
  it('adds a succeeded result as a copy bound to that source version, at its full length', () => {
    const result = accepted(plan(timeline([]), addResult(cid(1), SRC_A, 12, NEW_TRACK, OFF)));
    expect(createdCopy(result, cid(1))).toEqual({
      id: cid(1), trackId: V2, kind: 'web-animation', contentBinding: boundTo(SRC_A),
      startFrame: 12, sourceInFrame: 0, durationFrames: 48, rate: { num: 1, den: 1 }, gain: 1, mute: false,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    });
    expect(result.created).toEqual([cid(1)]);
  });

  it('adds an in-progress execution as a placeholder bound to the execution, at its accepted length', () => {
    const result = accepted(plan(timeline([]), addPlaceholder(cid(1), EXEC_RUNNING, 0, NEW_TRACK, OFF, 72)));
    expect(createdCopy(result, cid(1))).toMatchObject({ contentBinding: waitingFor(EXEC_RUNNING), durationFrames: 72, sourceInFrame: 0 });
  });

  it('plans the first copy of a result from the extent the command carries, before any resolution knows it', () => {
    const result = accepted(plan(timeline([]), addResult(cid(1), SRC_B, 0, NEW_TRACK, OFF, 96), EMPTY_RESOLUTION));
    expect(createdCopy(result, cid(1))).toMatchObject({ contentBinding: boundTo(SRC_B), durationFrames: 96 });
  });

  it('refuses an id that is already taken', () => {
    const refused = plan(timeline([clip(cid(1), MAIN, 0, 10)]), addResult(cid(1), SRC_A, 0, NEW_TRACK, OFF));
    expect(refused.ok ? 'ok' : refused.reason).toBe('id_taken');
  });

  it('is a command the schema accepts in both forms', () => {
    expect(TimelineEditCommandSchema.safeParse(addResult(cid(1), SRC_A, 0, NEW_TRACK, OFF)).success).toBe(true);
    expect(TimelineEditCommandSchema.safeParse(addPlaceholder(cid(1), EXEC_RUNNING, 0, NEW_TRACK, OFF)).success).toBe(true);
  });
});

describe('placeWebAnimationClip, through both adding commands', () => {
  it('starts above the main track when no video is over the span', () => {
    const doc = timeline([clip(cid(9), MAIN, 200, 10)]);
    expect(createdCopy(accepted(plan(doc, addResult(cid(1), SRC_A, 0, NEW_TRACK, OFF))), cid(1)).trackId).toBe(V2);
  });

  it('never lands on the main track, even when it is free', () => {
    const doc = timeline([], [track(MAIN, 0)]);
    const result = accepted(plan(doc, addResult(cid(1), SRC_A, 0, NEW_TRACK, OFF)));
    expect(createdCopy(result, cid(1)).trackId).toBe(NEW_TRACK);
    expect(result.next.tracks[NEW_TRACK]).toEqual({ id: NEW_TRACK, kind: 'visual', order: 1 });
  });

  it('goes to the first free visual track above the highest video over the span', () => {
    const tracks = [track(MAIN, 0), track(V2, 1), track(V3, 2), track(V4, 3)];
    const doc = timeline([clip(cid(8), MAIN, 0, 100), clip(cid(9), V2, 0, 100)], tracks);
    expect(createdCopy(accepted(plan(doc, addResult(cid(1), SRC_A, 10, NEW_TRACK, OFF))), cid(1)).trackId).toBe(V3);
  });

  it('skips a free track below a higher video over the span', () => {
    const tracks = [track(MAIN, 0), track(V2, 1), track(V3, 2), track(V4, 3)];
    const doc = timeline([clip(cid(9), V3, 0, 100)], tracks);
    expect(createdCopy(accepted(plan(doc, addResult(cid(1), SRC_A, 10, NEW_TRACK, OFF))), cid(1)).trackId).toBe(V4);
  });

  it('treats a track holding any clip over the span as taken', () => {
    const tracks = [track(MAIN, 0), track(V2, 1), track(V3, 2)];
    const doc = timeline([webClip(cid(9), V2, 40, 20)], tracks);
    expect(createdCopy(accepted(plan(doc, addResult(cid(1), SRC_A, 0, NEW_TRACK, OFF))), cid(1)).trackId).toBe(V3);
  });

  it('uses a track whose clips lie outside the span', () => {
    const doc = timeline([clip(cid(9), V2, 48, 20)]);
    expect(createdCopy(accepted(plan(doc, addResult(cid(1), SRC_A, 0, NEW_TRACK, OFF))), cid(1)).trackId).toBe(V2);
  });

  it('creates a new top track when every track above the highest video is taken, leaving the others alone', () => {
    const doc = timeline([clip(cid(8), MAIN, 0, 100), clip(cid(9), V2, 0, 100)]);
    const result = accepted(plan(doc, addPlaceholder(cid(1), EXEC_RUNNING, 10, NEW_TRACK, OFF)));
    expect(createdCopy(result, cid(1)).trackId).toBe(NEW_TRACK);
    expect(result.next.tracks[NEW_TRACK]).toEqual({ id: NEW_TRACK, kind: 'visual', order: 2 });
    expect(result.next.clips[cid(8)]).toEqual(doc.clips[cid(8)]);
    expect(result.next.clips[cid(9)]).toEqual(doc.clips[cid(9)]);
  });

  it('creates no track when an existing one is free', () => {
    const result = accepted(plan(timeline([]), addResult(cid(1), SRC_A, 0, NEW_TRACK, OFF)));
    expect(Object.keys(result.next.tracks).sort()).toEqual([MAIN, V2].sort());
  });

  it('places the copy that land_execution adds by the same rule', () => {
    const doc = timeline([clip(cid(8), MAIN, 0, 100), clip(cid(9), V2, 0, 100)]);
    const result = accepted(plan(doc, land(ACTION, RECEIPT, OFF, { clipId: cid(1), startFrame: 5, newTrackId: NEW_TRACK, extent: { acceptedDurationFrames: 72, fps: FPS } })));
    expect(createdCopy(result, cid(1))).toMatchObject({ trackId: NEW_TRACK, startFrame: 5, durationFrames: 72, contentBinding: waitingFor(EXEC_RUNNING) });
  });
});

describe('land_execution', () => {
  it('writes the receipt alone when it adds no copy', () => {
    const doc = timeline([clip(cid(1), MAIN, 0, 10)]);
    const result = accepted(plan(doc, land(ACTION, RECEIPT, OFF)));
    expect(result.next.operationReceipts).toEqual({ [ACTION]: RECEIPT });
    expect(result.next.clips).toEqual(doc.clips);
    expect(result.next.tracks).toEqual(doc.tracks);
  });

  it('keeps the receipts already in the document', () => {
    const other = 'a0000000-0000-4000-8000-000000000002';
    const doc = { ...timeline([]), operationReceipts: { [other]: { ...RECEIPT, executionId: EXEC_DONE } } };
    expect(accepted(plan(doc, land(ACTION, RECEIPT, OFF))).next.operationReceipts).toEqual({ [other]: { ...RECEIPT, executionId: EXEC_DONE }, [ACTION]: RECEIPT });
  });

  it('is a command the schema accepts with and without a copy', () => {
    expect(TimelineEditCommandSchema.safeParse(land(ACTION, RECEIPT, OFF)).success).toBe(true);
    expect(TimelineEditCommandSchema.safeParse(land(ACTION, RECEIPT, OFF, { clipId: cid(1), startFrame: 0, newTrackId: NEW_TRACK, extent: { acceptedDurationFrames: 24, fps: FPS } })).success).toBe(true);
  });

  it('carries the receipts through every other command unchanged', () => {
    const doc = { ...timeline([webClip(cid(1), V2, 0, 48)]), operationReceipts: { [ACTION]: RECEIPT } };
    expect(accepted(plan(doc, move(cid(1), 10))).next.operationReceipts).toEqual({ [ACTION]: RECEIPT });
  });
});

describe('copies are independent (fast-check)', () => {
  const starts = fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 6 });

  it('gives every addition of one result its own id and the same fixed binding, never touching earlier copies', () => {
    fc.assert(fc.property(starts, fc.boolean(), (frames, fromExecution) => {
      let doc = timeline([clip(cid(90), MAIN, 0, 500)]);
      const ids: string[] = [];
      frames.forEach((frame, index) => {
        const id = cid(index + 1);
        const command = fromExecution ? addPlaceholder(id, EXEC_RUNNING, frame, `track-${index}`, OFF) : addResult(id, SRC_A, frame, `track-${index}`, OFF);
        const before = doc;
        const result = accepted(planTimelineEdit(doc, command, idFactory(), RESOLUTION));
        for (const previous of ids) expect(result.next.clips[previous]).toEqual(before.clips[previous]);
        expect(result.next.clips[cid(90)]).toEqual(before.clips[cid(90)]);
        ids.push(id);
        doc = result.next;
      });
      const copies = ids.map((id) => doc.clips[id]);
      expect(new Set(copies.map((copy) => copy?.id)).size).toBe(frames.length);
      for (const copy of copies) {
        expect(copy?.kind).toBe('web-animation');
        expect(copy?.kind === 'web-animation' ? copy.contentBinding : null).toEqual(fromExecution ? waitingFor(EXEC_RUNNING) : boundTo(SRC_A));
      }
    }));
  });

  it('changes only the copy an edit names; the other copies of the same result keep every field', () => {
    const edit = fc.oneof(
      fc.record({ kind: fc.constant('move' as const), start: fc.integer({ min: 0, max: 300 }) }),
      fc.record({ kind: fc.constant('range' as const), sourceIn: fc.integer({ min: 0, max: 40 }), length: fc.integer({ min: 1, max: 8 }) }),
      fc.record({ kind: fc.constant('delete' as const) }),
    );
    fc.assert(fc.property(fc.integer({ min: 2, max: 5 }), fc.nat(), edit, (count, pick, change) => {
      const tracks = [track(MAIN, 0), ...Array.from({ length: count }, (_, index) => track(`copy-${index}`, index + 1))];
      const copies = Array.from({ length: count }, (_, index) => webClip(cid(index + 1), `copy-${index}`, index * 10, 24));
      const doc = { ...timeline(copies, tracks), operationReceipts: { [ACTION]: RECEIPT } };
      const target = copies[pick % count];
      if (target === undefined) return;
      const command: TimelineEditCommand = change.kind === 'move' ? move(target.id, change.start)
        : change.kind === 'range' ? setRange(target.id, target.startFrame, change.sourceIn, change.length)
          : { operation: 'delete', parameters: { clipId: target.id }, placement: OFF };
      const result = accepted(planTimelineEdit(doc, command, idFactory(), RESOLUTION));
      for (const other of copies) if (other.id !== target.id) expect(result.next.clips[other.id]).toEqual(other);
      // Removing or changing a placement never touches the execution's landing record.
      expect(result.next.operationReceipts).toEqual({ [ACTION]: RECEIPT });
    }));
  });
});
