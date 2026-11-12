// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Upload placeholders in the Timeline arrangement and planner (#1434 design §2, §2.1, §3.2).
 *
 * An `upload` clip is measured like a video whose source is the file the browser read: its extent is
 * `{ timebase: settings.fps, extentFrames: durationToFrames(upload.durationSeconds, fps), durationSeconds }`. It never
 * lacks a source, so it is never `missing_source` or `source_unresolved`; overlap, a missing or audio track and a range
 * past its duration are conflicts exactly as for a video. Every edit plans it as a video clip, and a web-animation
 * copy added over it goes above it, so the copy stays visible once the placeholder turns into a video.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import type { TimelineDocumentV1 } from '@breatic/shared';

import { resolveTimelineArrangement, resolveTimelineClipExtent } from '@web/data/yjs/timeline-arrangement';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import { TimelineEditCommandSchema, planTimelineEdit, type TimelineEditCommand, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { visibleTimelineClipsAt } from '@web/data/yjs/timeline-layers';
import {
  FPS, MAIN, OFF, ON, SOURCE, V2, V3, V4, cid, clip, idFactory, seededDoc, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { RESOLUTION, SRC_A, addResult } from '@web/data/yjs/__tests__/timeline-web-fixtures';
import {
  OTHER_UPLOAD_ID, UPLOAD_FRAMES, UPLOAD_ID, UPLOAD_NAME, UPLOAD_SECONDS, addUpload, uploadClip,
} from '@web/data/yjs/__tests__/timeline-upload-fixtures';

type Accepted = Extract<TimelineEditPlan, { ok: true }>;

const NEW_TRACK = 'track-new';

/**
 * Plan an edit, checking the input is left as it was.
 * @param current - The document.
 * @param command - The edit.
 * @returns The plan.
 * @throws {Error} When planning mutates its input.
 */
function plan(current: TimelineDocumentV1, command: TimelineEditCommand): TimelineEditPlan {
  const before = structuredClone(current);
  const result = planTimelineEdit(current, command, idFactory(), RESOLUTION);
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
 * The refusal reason of a plan, or 'ok'.
 * @param result - The plan.
 * @returns Its reason.
 * @throws {never} Never.
 */
function reason(result: TimelineEditPlan): string {
  return result.ok ? 'ok' : result.reason;
}

/**
 * The arrangement's conflict codes for one clip.
 * @param document - The document.
 * @param clipId - The clip.
 * @returns Its reason codes.
 * @throws {never} Never.
 */
function codes(document: TimelineDocumentV1, clipId: string): string[] {
  return resolveTimelineArrangement(document, RESOLUTION).placements.find((item) => item.clipId === clipId)?.reasons.map((item) => item.code) ?? [];
}

const move = (clipId: string, startFrame: number, target: { trackId?: string } = {}): TimelineEditCommand =>
  ({ operation: 'move', parameters: { clipId, startFrame, ...target }, placement: OFF });
const setRange = (clipId: string, startFrame: number, sourceInFrame: number, durationFrames: number): TimelineEditCommand =>
  ({ operation: 'set_range', parameters: { clipId, startFrame, sourceInFrame, durationFrames }, placement: OFF });

describe('resolveTimelineClipExtent for an upload placeholder', () => {
  it('measures it by the duration the browser read, in the document frame rate', () => {
    const doc = timeline([uploadClip(cid(1), V2, 0)], undefined, []);
    expect(resolveTimelineClipExtent(doc, RESOLUTION, uploadClip(cid(1), V2, 0))).toMatchObject({ timebase: FPS, extentFrames: UPLOAD_FRAMES });
  });

  it('rounds a fractional duration up to the frame whose sample starts before the end', () => {
    const doc = timeline([], undefined, []);
    const placeholder = uploadClip(cid(1), V2, 0, 10, { upload: { uploadId: UPLOAD_ID, name: UPLOAD_NAME, durationSeconds: 2.01 } });
    expect(resolveTimelineClipExtent(doc, RESOLUTION, placeholder)).toMatchObject({ timebase: FPS, extentFrames: 49 });
  });

  it('needs neither a document source nor a web resolution', () => {
    const doc = timeline([], undefined, []);
    expect(resolveTimelineClipExtent(doc, { sources: {}, executions: {} }, uploadClip(cid(1), V2, 0))).toMatchObject({ extentFrames: UPLOAD_FRAMES });
  });
});

describe('resolveTimelineArrangement with upload placeholders', () => {
  it('counts a placeholder inside its duration as ready, with no sources in the document', () => {
    const doc = timeline([uploadClip(cid(1), MAIN, 0), uploadClip(cid(2), V2, 100, 30, { sourceInFrame: 30 })], undefined, []);
    expect(resolveTimelineArrangement(doc).readyClipIds).toEqual([cid(1), cid(2)]);
  });

  it('never reports a placeholder as missing_source or source_unresolved', () => {
    const doc = timeline([uploadClip(cid(1), V2, 0, 70, { sourceInFrame: 10 })], undefined, []);
    const all = codes(doc, cid(1));
    expect(all).not.toContain('missing_source');
    expect(all).not.toContain('source_unresolved');
  });

  it('reports a placeholder reading past its duration as invalid_range', () => {
    const doc = timeline([uploadClip(cid(1), V2, 0, 40, { sourceInFrame: 30 })], undefined, []);
    expect(codes(doc, cid(1))).toEqual(['invalid_range']);
  });

  it('reports a placeholder and a video overlapping on one track as an overlap, both ways', () => {
    const doc = timeline([clip(cid(1), V2, 0, 48), uploadClip(cid(2), V2, 20)]);
    expect(codes(doc, cid(1))).toEqual(['overlap']);
    expect(codes(doc, cid(2))).toEqual(['overlap']);
  });

  it('reports a placeholder on a missing track or an audio track like a video', () => {
    const tracks = [track(MAIN, 0), { id: 'audio-1', kind: 'audio' as const, order: 1 }];
    const doc = timeline([uploadClip(cid(1), 'gone', 0), uploadClip(cid(2), 'audio-1', 0)], tracks, []);
    expect(codes(doc, cid(1))).toEqual(['missing_track']);
    expect(codes(doc, cid(2))).toEqual(['incompatible_track']);
  });
});

describe('add_upload', () => {
  it('is a command the schema accepts with and without a new track', () => {
    expect(TimelineEditCommandSchema.safeParse(addUpload(uploadClip(cid(1), V2, 0), OFF)).success).toBe(true);
    expect(TimelineEditCommandSchema.safeParse(addUpload(uploadClip(cid(1), MAIN, 0), OFF, NEW_TRACK)).success).toBe(true);
  });

  it('refuses a placeholder with bad upload fields through the command schema', () => {
    const bad = uploadClip(cid(1), V2, 0, UPLOAD_FRAMES, { upload: { uploadId: 'not-a-uuid', name: UPLOAD_NAME, durationSeconds: UPLOAD_SECONDS } });
    expect(TimelineEditCommandSchema.safeParse(addUpload(bad, OFF)).success).toBe(false);
  });

  it('places the placeholder where it was confirmed and adds no source', () => {
    const doc = timeline([clip(cid(9), MAIN, 0, 100)]);
    const placeholder = uploadClip(cid(1), V2, 12);
    const result = accepted(plan(doc, addUpload(placeholder, OFF)));
    expect(result.next.clips[cid(1)]).toEqual(placeholder);
    expect(result.created).toEqual([cid(1)]);
    expect(result.next.sources).toEqual(doc.sources);
  });

  it('creates the new top track the command names, like add_video', () => {
    const result = accepted(plan(timeline([]), addUpload(uploadClip(cid(1), MAIN, 0), OFF, NEW_TRACK)));
    expect(result.next.clips[cid(1)]).toMatchObject({ kind: 'upload', trackId: NEW_TRACK });
    expect(result.next.tracks[NEW_TRACK]).toEqual({ id: NEW_TRACK, kind: 'visual', order: 2 });
  });

  it('refuses an id that is already taken', () => {
    expect(reason(plan(timeline([clip(cid(1), MAIN, 0, 10)]), addUpload(uploadClip(cid(1), V2, 0), OFF)))).toBe('id_taken');
  });

  it('refuses a placeholder longer than the file', () => {
    expect(reason(plan(timeline([]), addUpload(uploadClip(cid(1), V2, 0, UPLOAD_FRAMES + 1), OFF)))).toBe('invalid_range');
  });

  it('plans exactly as add_video would for a video of the same length', () => {
    const cases = [
      { placement: OFF, trackId: V2, startFrame: 30 },
      { placement: OFF, trackId: MAIN, startFrame: 20 },
      { placement: ON, trackId: MAIN, startFrame: 70 },
      { placement: ON, trackId: MAIN, startFrame: 0 },
    ];
    for (const { placement, trackId, startFrame } of cases) {
      const sameSource = { ...SOURCE, extentFrames: UPLOAD_FRAMES, durationSeconds: String(UPLOAD_SECONDS) };
      const doc = timeline([clip(cid(7), MAIN, 0, 48), clip(cid(8), MAIN, 48, 48), clip(cid(9), V2, 40, 30)], undefined, [sameSource]);
      const placeholder = uploadClip(cid(1), trackId, startFrame);
      const { kind: _kind, upload: _upload, ...fields } = placeholder;
      const video = { ...fields, kind: 'video' as const, sourceId: sameSource.id };
      const viaVideo = accepted(plan(doc, { operation: 'add_video', parameters: { source: sameSource, clip: video }, placement }));
      const viaUpload = accepted(plan(doc, addUpload(placeholder, placement)));
      const layout = (next: TimelineDocumentV1): unknown => Object.values(next.clips).map(({ id, trackId: track, startFrame: start, sourceInFrame, durationFrames }) => ({ id, track, start, sourceInFrame, durationFrames }))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(layout(viaUpload.next), `${JSON.stringify({ trackId, startFrame, placement })}`).toEqual(layout(viaVideo.next));
      expect(viaUpload.next.clips[cid(1)]).toMatchObject({ kind: 'upload', upload: placeholder.upload });
    }
  });

  it('writes the placeholder record and leaves the sources alone', () => {
    const doc = seededDoc(timeline([clip(cid(9), MAIN, 0, 100)]));
    const placeholder = uploadClip(cid(1), V2, 0);
    expect(applyTimelineEdit(doc, addUpload(placeholder, OFF), Symbol('edit')).ok).toBe(true);
    const read = readTimelineDocument(doc);
    expect(read.clips[cid(1)]).toEqual(placeholder);
    expect(Object.keys(read.sources)).toEqual([SOURCE.id]);
    expect(doc.getMap('clips').get(cid(1))).toBeInstanceOf(Y.Map);
  });
});

describe('editing an upload placeholder plans it as a video', () => {
  it('moves it to another frame and track', () => {
    const doc = timeline([uploadClip(cid(1), V2, 0)], [track(MAIN, 0), track(V2, 1), track(V3, 2)], []);
    expect(accepted(plan(doc, move(cid(1), 30, { trackId: V3 }))).next.clips[cid(1)]).toMatchObject({ kind: 'upload', trackId: V3, startFrame: 30, upload: { uploadId: UPLOAD_ID } });
  });

  it('lets a range reach the end of the file and refuses one past it', () => {
    const doc = timeline([uploadClip(cid(1), V2, 0, 30)], undefined, []);
    expect(accepted(plan(doc, setRange(cid(1), 0, 30, 30))).next.clips[cid(1)]).toMatchObject({ sourceInFrame: 30, durationFrames: 30 });
    expect(reason(plan(doc, setRange(cid(1), 0, 30, 31)))).toBe('invalid_range');
  });

  it('splits it into two placeholders sharing one uploadId, the right one reading on from the cut', () => {
    const doc = timeline([uploadClip(cid(1), V2, 10, 50, { sourceInFrame: 4 })], undefined, []);
    const result = accepted(plan(doc, { operation: 'split', parameters: { clipId: cid(1), frame: 25, newClipId: cid(2) }, placement: OFF }));
    expect(result.next.clips[cid(1)]).toMatchObject({ kind: 'upload', startFrame: 10, sourceInFrame: 4, durationFrames: 15, upload: { uploadId: UPLOAD_ID } });
    expect(result.next.clips[cid(2)]).toMatchObject({ kind: 'upload', startFrame: 25, sourceInFrame: 19, durationFrames: 35, upload: { uploadId: UPLOAD_ID } });
  });

  it('duplicates it under a new id with the same upload', () => {
    const doc = timeline([uploadClip(cid(1), V2, 0, 20)], undefined, []);
    const result = accepted(plan(doc, { operation: 'duplicate', parameters: { clipId: cid(1), newClipId: cid(2) }, placement: OFF }));
    expect(result.next.clips[cid(2)]).toMatchObject({ kind: 'upload', startFrame: 20, durationFrames: 20, upload: { uploadId: UPLOAD_ID, name: UPLOAD_NAME, durationSeconds: UPLOAD_SECONDS } });
    expect(result.next.clips[cid(1)]).toEqual(doc.clips[cid(1)]);
  });

  it('deletes it', () => {
    const doc = timeline([uploadClip(cid(1), V2, 0)], undefined, []);
    expect(accepted(plan(doc, { operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF })).next.clips[cid(1)]).toBeUndefined();
  });

  it('trims a placeholder whose head a moved video covers, advancing its in-point by the file', () => {
    const doc = timeline([uploadClip(cid(1), V2, 20, 40), clip(cid(2), V2, 100, 10)]);
    expect(accepted(plan(doc, move(cid(2), 15))).next.clips[cid(1)]).toMatchObject({ startFrame: 25, sourceInFrame: 5, durationFrames: 35 });
  });

  it('packs a placeholder on the magnetic main track like a video', () => {
    const doc = timeline([clip(cid(1), MAIN, 0, 48), uploadClip(cid(2), MAIN, 48)]);
    const result = accepted(plan(doc, { operation: 'delete', parameters: { clipId: cid(1) }, placement: ON }));
    expect(result.next.clips[cid(2)]).toMatchObject({ kind: 'upload', startFrame: 0 });
  });

  it('keeps two uploads apart when one is duplicated', () => {
    const other = uploadClip(cid(2), V3, 0, 30, { upload: { uploadId: OTHER_UPLOAD_ID, name: 'other.mov', durationSeconds: 3 } });
    const doc = timeline([uploadClip(cid(1), V2, 0, 20), other], [track(MAIN, 0), track(V2, 1), track(V3, 2)], []);
    const result = accepted(plan(doc, { operation: 'duplicate', parameters: { clipId: cid(2), newClipId: cid(3) }, placement: OFF }));
    expect(result.next.clips[cid(3)]).toMatchObject({ upload: { uploadId: OTHER_UPLOAD_ID } });
    expect(result.next.clips[cid(1)]).toEqual(doc.clips[cid(1)]);
  });
});

describe('placeWebAnimationClip treats a placeholder as a video', () => {
  const tracks = [track(MAIN, 0), track(V2, 1), track(V3, 2), track(V4, 3)];

  it('puts a web copy above an uploading placeholder, not on the free track below it', () => {
    const doc = timeline([uploadClip(cid(9), V3, 0)], tracks, []);
    const result = accepted(plan(doc, addResult(cid(1), SRC_A, 10, NEW_TRACK, OFF)));
    expect(result.next.clips[cid(1)]?.trackId).toBe(V4);
  });

  it('keeps the web copy visible once the placeholder turns into a video', () => {
    const doc = timeline([uploadClip(cid(9), V3, 0)], tracks, []);
    const result = accepted(plan(doc, addResult(cid(1), SRC_A, 10, NEW_TRACK, OFF)));
    // What the upload's conversion writes: the same placement, now a video of the registered asset.
    const placeholder = result.next.clips[cid(9)];
    if (placeholder?.kind !== 'upload') throw new Error('Expected the placeholder to stay');
    const { kind: _kind, upload: _upload, ...fields } = placeholder;
    const converted: TimelineDocumentV1 = { ...result.next, sources: { [SOURCE.id]: SOURCE }, clips: { ...result.next.clips, [cid(9)]: { ...fields, kind: 'video', sourceId: SOURCE.id } } };
    const ready = new Set(resolveTimelineArrangement(converted, RESOLUTION).readyClipIds);
    expect(visibleTimelineClipsAt(converted, ready, 20).map((item) => item.id)).toEqual([cid(9), cid(1)]);
  });

  it('creates a new top track when the placeholder holds the highest track', () => {
    const doc = timeline([uploadClip(cid(9), V4, 0)], tracks, []);
    const result = accepted(plan(doc, addResult(cid(1), SRC_A, 10, NEW_TRACK, OFF)));
    expect(result.next.clips[cid(1)]?.trackId).toBe(NEW_TRACK);
  });
});

describe('a placeholder is planned like a video of the same length (fast-check)', () => {
  it('gives every move, range and delete the same layout as for the equivalent video', () => {
    const edit = fc.oneof(
      fc.record({ kind: fc.constant('move' as const), start: fc.integer({ min: 0, max: 200 }), onMain: fc.boolean() }),
      fc.record({ kind: fc.constant('range' as const), sourceIn: fc.integer({ min: 0, max: 70 }), length: fc.integer({ min: 1, max: 70 }) }),
      fc.record({ kind: fc.constant('split' as const), at: fc.integer({ min: 1, max: 59 }) }),
      fc.record({ kind: fc.constant('delete' as const) }),
    );
    fc.assert(fc.property(edit, fc.boolean(), fc.boolean(), (change, magnet, linkage) => {
      const placement = { magnet, linkage };
      const sameSource = { ...SOURCE, extentFrames: UPLOAD_FRAMES, durationSeconds: String(UPLOAD_SECONDS) };
      const others = [clip(cid(7), MAIN, 0, 48, { sourceId: sameSource.id }), clip(cid(8), V2, 80, 30, { sourceId: sameSource.id })];
      const placeholder = uploadClip(cid(1), V2, 10);
      const { kind: _kind, upload: _upload, ...fields } = placeholder;
      const asUpload = timeline([...others, placeholder], undefined, [sameSource]);
      const asVideo = timeline([...others, { ...fields, kind: 'video', sourceId: sameSource.id }], undefined, [sameSource]);
      const command: TimelineEditCommand = change.kind === 'move' ? { operation: 'move', parameters: { clipId: cid(1), startFrame: change.start, ...(change.onMain ? { trackId: MAIN } : {}) }, placement }
        : change.kind === 'range' ? { operation: 'set_range', parameters: { clipId: cid(1), startFrame: 10, sourceInFrame: change.sourceIn, durationFrames: change.length }, placement }
          : change.kind === 'split' ? { operation: 'split', parameters: { clipId: cid(1), frame: 10 + change.at, newClipId: cid(2) }, placement }
            : { operation: 'delete', parameters: { clipId: cid(1) }, placement };
      const viaUpload = planTimelineEdit(asUpload, command, idFactory(), RESOLUTION);
      const viaVideo = planTimelineEdit(asVideo, command, idFactory(), RESOLUTION);
      expect(viaUpload.ok).toBe(viaVideo.ok);
      if (!viaUpload.ok || !viaVideo.ok) {
        expect(reason(viaUpload)).toBe(reason(viaVideo));
        return;
      }
      const layout = (next: TimelineDocumentV1): unknown => Object.values(next.clips).map(({ id, trackId, startFrame, sourceInFrame, durationFrames }) => ({ id, trackId, startFrame, sourceInFrame, durationFrames }))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(layout(viaUpload.next)).toEqual(layout(viaVideo.next));
      for (const id of [cid(1), cid(2)]) {
        const item = viaUpload.next.clips[id];
        if (item !== undefined) expect(item).toMatchObject({ kind: 'upload', upload: placeholder.upload });
      }
    }));
  });
});
