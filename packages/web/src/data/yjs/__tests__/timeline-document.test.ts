// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import * as sharedIndex from '@breatic/shared';
import * as spaceContent from '@breatic/shared/space-content';
import { initializeTimelineDocument } from '@breatic/shared/space-content';
import { applyTimelineEdit, readTimelineContent, readTimelineDocument, missingTimelineSourceIds, removeTimelineClip, timelineClipSourceId } from '@web/data/yjs/timeline-document';
import { planTimelineEdit } from '@web/data/yjs/timeline-edit';
import type { TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { TimelineDocumentV1Schema } from '@breatic/shared';
import type { TimelineDocumentV1, TimelineVideoClip } from '@breatic/shared';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import {
  MAIN, OFF, ON, SHORT_SOURCE, SOURCE, V2, cid, clip as fixtureClip, idFactory, starts, timeline,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';

const settings = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const source = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'video' as const,
  assetId: '20000000-0000-4000-8000-000000000001',
  timebase: settings.fps,
  extentFrames: 48,
  durationSeconds: '2',
  durationOrigin: 'registered' as const,
};
const clip = {
  id: '30000000-0000-4000-8000-000000000001',
  trackId: 'visual-1',
  kind: 'video' as const,
  sourceId: source.id,
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 48,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const add: TimelineEditCommand = {
  operation: 'add_video',
  parameters: { source, clip },
  placement: ON,
};
const ORIGIN = Symbol('timeline-test-session');
const OTHER_ORIGIN = Symbol('timeline-other-session');
const docs: Y.Doc[] = [];

/**
 * Keep each real Yjs document available for deterministic cleanup.
 * @returns A new document, optionally loaded from an encoded snapshot.
 * @throws {Error} When the supplied Yjs update cannot be decoded.
 */
function trackedDoc(update?: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  docs.push(doc);
  if (update !== undefined) Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Create the server-owned initial Timeline state for an editing test.
 * @returns The seeded document.
 * @throws {Error} When the initial state cannot be constructed.
 */
function seededDoc(): Y.Doc {
  const doc = trackedDoc();
  initializeTimelineDocument(doc, settings);
  return doc;
}

/**
 * Write a fixture DTO into a seeded document directly, without the code under test.
 * @param dto - The schema-checked fixture.
 * @returns The document holding exactly that content.
 * @throws {Error} When the fixture differs from the seeded settings.
 */
function docFrom(dto: TimelineDocumentV1): Y.Doc {
  const doc = seededDoc();
  doc.transact(() => {
    const tracks = doc.getMap<unknown>('tracks');
    for (const id of [...tracks.keys()]) if (dto.tracks[id] === undefined) tracks.delete(id);
    for (const item of Object.values(dto.tracks)) {
      if (tracks.has(item.id)) continue;
      const child = new Y.Map<unknown>();
      tracks.set(item.id, child);
      for (const [key, value] of Object.entries(item)) child.set(key, value);
    }
    const clips = doc.getMap<unknown>('clips');
    for (const item of Object.values(dto.clips)) {
      const child = new Y.Map<unknown>();
      clips.set(item.id, child);
      for (const [key, value] of Object.entries(item)) child.set(key, value);
    }
    for (const item of Object.values(dto.sources)) doc.getMap('sources').set(item.id, item);
  });
  expect(readTimelineDocument(doc)).toEqual(dto);
  return doc;
}

/**
 * Narrow a plan to its accepted branch, failing with the refusal reason otherwise.
 * @param plan - The plan.
 * @returns The accepted plan.
 * @throws {Error} When the plan was refused.
 */
function accepted(plan: TimelineEditPlan): Extract<TimelineEditPlan, { ok: true }> {
  if (!plan.ok) throw new Error(`Expected an accepted plan, got ${plan.reason}`);
  return plan;
}

/**
 * The per-user undo manager the Timeline edit session holds.
 * @param doc - The document.
 * @param origin - The session origin.
 * @returns The undo manager.
 * @throws {never} Never.
 */
function undoManager(doc: Y.Doc, origin: symbol): Y.UndoManager {
  return new Y.UndoManager([doc.getMap('tracks'), doc.getMap('clips'), doc.getMap('sources')], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
}

/**
 * Exchange full state between two replicas.
 * @param left - One replica.
 * @param right - The other replica.
 * @throws {Error} When an update cannot be decoded.
 */
function sync(left: Y.Doc, right: Y.Doc): void {
  const leftBytes = Y.encodeStateAsUpdate(left);
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
  Y.applyUpdate(right, leftBytes);
}

/**
 * Record the clip and track keys each transaction changes, as `path:key`.
 * @param doc - The document to observe.
 * @returns The live list of changes.
 * @throws {never} Never.
 */
function recordChanges(doc: Y.Doc): string[] {
  const changes: string[] = [];
  for (const name of ['clips', 'tracks', 'sources']) {
    doc.getMap(name).observeDeep((events) => {
      for (const event of events) for (const key of (event as Y.YMapEvent<unknown>).keysChanged) changes.push(`${[name, ...event.path].join('/')}:${key}`);
    });
  }
  return changes;
}

/**
 * The `path:key` writes an edit from `before` to `after` must make, and no others.
 * @param before - The document before the edit.
 * @param after - The planned document.
 * @returns The expected changes.
 * @throws {never} Never.
 */
function expectedChanges(before: TimelineDocumentV1, after: TimelineDocumentV1): string[] {
  const changes: string[] = [];
  for (const name of ['clips', 'tracks'] as const) {
    const previous: Record<string, object> = before[name];
    const next: Record<string, object> = after[name];
    for (const id of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const was = previous[id];
      const now = next[id];
      if (was === undefined || now === undefined) {
        changes.push(`${name}:${id}`);
        continue;
      }
      for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (JSON.stringify(Reflect.get(was, key)) !== JSON.stringify(Reflect.get(now, key))) changes.push(`${name}/${id}:${key}`);
      }
    }
  }
  // Sources (inner#1708 L2, L4): every created clip re-sets its source, a new source is added, an unreferenced one deleted.
  const sources = new Set<string>();
  for (const [id, item] of Object.entries(after.clips)) if (before.clips[id] === undefined) sources.add(item.sourceId);
  for (const id of Object.keys(after.sources)) if (before.sources[id] === undefined) sources.add(id);
  for (const id of Object.keys(before.sources)) if (after.sources[id] === undefined) sources.add(id);
  for (const id of sources) changes.push(`sources:${id}`);
  return changes.sort();
}

/**
 * A value as JSON with object keys sorted, so records compare regardless of key order.
 * @param value - The value.
 * @returns Its canonical JSON.
 * @throws {never} Never.
 */
function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(Reflect.get(item, key))]))
    : item;
  return JSON.stringify(sorted(value));
}

/**
 * Whether two documents hold the same track and clip records by id, whatever their key order.
 * @param before - One document.
 * @param after - The other document.
 * @returns True when no track or clip record differs.
 * @throws {never} Never.
 */
function sameRecords(before: TimelineDocumentV1, after: TimelineDocumentV1): boolean {
  return canonical({ tracks: before.tracks, clips: before.clips }) === canonical({ tracks: after.tracks, clips: after.clips });
}

const move = (clipId: string, startFrame: number, placement: TimelineEditPlacement, target: { trackId?: string } = {}): TimelineEditCommand =>
  ({ operation: 'move', parameters: { clipId, startFrame, ...target }, placement });
const setRange = (clipId: string, startFrame: number, sourceInFrame: number, durationFrames: number, placement: TimelineEditPlacement): TimelineEditCommand =>
  ({ operation: 'set_range', parameters: { clipId, startFrame, sourceInFrame, durationFrames }, placement });
const addVideo = (added: TimelineVideoClip, placement: TimelineEditPlacement, addedSource = SOURCE): TimelineEditCommand =>
  ({ operation: 'add_video', parameters: { source: addedSource, clip: added }, placement });

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  vi.restoreAllMocks();
});

describe('Timeline native edit transactions', () => {
  it('plans an edit against the read document without writing source or layout', () => {
    const doc = seededDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const plan = accepted(planTimelineEdit(readTimelineDocument(doc), add, idFactory()));
    expect(plan.next.clips).toEqual({ [clip.id]: clip });
    expect(plan.next.sources).toEqual({ [source.id]: source });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({});
    expect(readTimelineDocument(doc).sources).toEqual({});
  });

  it('writes the source and attached clip in one transaction carrying the caller\'s origin', () => {
    const doc = seededDoc();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshots: ReturnType<typeof readTimelineDocument>[] = [];
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => {
      origins.push(transaction.origin);
      snapshots.push(readTimelineDocument(doc));
    });
    const plan = applyTimelineEdit(doc, add, ORIGIN);
    expect(plan.ok).toBe(true);
    expect(origins).toEqual([ORIGIN]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      clips: { [clip.id]: clip },
      sources: { [source.id]: source },
    });
    expect(doc.getMap('clips').get(clip.id)).toBeInstanceOf(Y.Map);
    expect(warn.mock.calls.filter((args) => args.some((arg) => String(arg).includes('Invalid access')))).toEqual([]);
  });

  it('returns the plan whose next document is what the doc then reads', () => {
    const doc = docFrom(timeline([fixtureClip(cid(1), MAIN, 0, 48), fixtureClip(cid(2), MAIN, 48, 24), fixtureClip(cid(3), V2, 50, 10)]));
    const plan = accepted(applyTimelineEdit(doc, setRange(cid(1), 0, 0, 30, ON), ORIGIN));
    expect(readTimelineDocument(doc)).toEqual(plan.next);
  });

  it('reopens the exact document parameters, source and placement', () => {
    const doc = seededDoc();
    applyTimelineEdit(doc, add, ORIGIN);
    const reopened = trackedDoc(Y.encodeStateAsUpdate(doc));
    expect(readTimelineDocument(reopened)).toEqual(readTimelineDocument(doc));
    expect(readTimelineDocument(reopened).settings).toEqual(settings);
    expect(readTimelineDocument(reopened).clips[clip.id]).toEqual(clip);
  });

  it('moves only the current clip start while preserving its source', () => {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add, ORIGIN).ok).toBe(true);
    expect(applyTimelineEdit(doc, move(clip.id, 144, OFF), ORIGIN).ok).toBe(true);
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual({ ...clip, startFrame: 144 });
    expect(readTimelineDocument(doc).sources).toEqual({ [source.id]: source });
  });

  it('keeps stored source and clip snapshots unchanged when callers mutate their command inputs', () => {
    const doc = seededDoc();
    const command = structuredClone(add);
    expect(applyTimelineEdit(doc, command, ORIGIN).ok).toBe(true);
    if (command.operation !== 'add_video') throw new Error('The fixture is an addition');
    const before = Y.encodeStateAsUpdate(doc);
    for (const mutate of [
      () => Reflect.set(command.parameters.source, 'durationSeconds', '9'),
      () => Reflect.set(command.parameters.clip, 'startFrame', 144),
      () => Reflect.set(command.parameters.clip.transform, 'x', 17),
    ]) {
      try {
        mutate();
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
    }
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).sources[source.id]).toEqual(source);
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual(clip);
  });

  it('overwrites the covered part of a sub-track clip when another clip is added over it', () => {
    const doc = docFrom(timeline([{ ...clip, trackId: V2 }], undefined, [source]));
    const nextClip = { ...clip, id: cid(9), trackId: V2, startFrame: 24 };
    const plan = accepted(applyTimelineEdit(doc, addVideo(nextClip, ON, source), ORIGIN));
    expect(starts(readTimelineDocument(doc), V2)).toEqual([[clip.id, 0, 24], [nextClip.id, 24, 48]]);
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual({ ...clip, trackId: V2, durationFrames: 24 });
    expect(Object.keys(plan.next.clips).sort()).toEqual([clip.id, nextClip.id].sort());
  });

  it('inserts an addition on the magnetic main track by the drop frame instead of refusing it', () => {
    for (const [dropFrame, expected] of [
      [24, [[clip.id, 0, 48], [cid(9), 48, 48]]],
      [23, [[cid(9), 0, 48], [clip.id, 48, 48]]],
    ] as const) {
      const doc = seededDoc();
      expect(applyTimelineEdit(doc, add, ORIGIN).ok).toBe(true);
      const nextClip = { ...clip, id: cid(9), startFrame: dropFrame };
      expect(applyTimelineEdit(doc, addVideo(nextClip, ON, source), ORIGIN).ok).toBe(true);
      expect(starts(readTimelineDocument(doc), MAIN)).toEqual(expected);
    }
  });

  it('overwrites on the main track when the magnet is off', () => {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add, ORIGIN).ok).toBe(true);
    const nextClip = { ...clip, id: cid(9), startFrame: 24 };
    expect(applyTimelineEdit(doc, addVideo(nextClip, OFF, source), ORIGIN).ok).toBe(true);
    expect(starts(readTimelineDocument(doc), MAIN)).toEqual([[clip.id, 0, 24], [cid(9), 24, 48]]);
  });

  it('refuses a missing target without writing and can edit it once the clip exists', () => {
    const doc = seededDoc();
    const missing = move(clip.id, 144, OFF);
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on('update', updates);
    expect(applyTimelineEdit(doc, missing, ORIGIN)).toEqual({ ok: false, reason: 'target_missing' });
    expect(updates).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({});
    expect(readTimelineDocument(doc).sources).toEqual({});
    expect(applyTimelineEdit(doc, add, ORIGIN).ok).toBe(true);
    expect(applyTimelineEdit(doc, missing, ORIGIN).ok).toBe(true);
    expect(readTimelineDocument(doc).clips[clip.id]).toEqual({ ...clip, startFrame: 144 });
  });

  it('refuses an addition whose clip identity already exists without replacing its layout or source', () => {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add, ORIGIN).ok).toBe(true);
    const nextSource = { ...source, id: '10000000-0000-4000-8000-000000000002' };
    const reused = addVideo({ ...clip, sourceId: nextSource.id, startFrame: 144 }, ON, nextSource);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applyTimelineEdit(doc, reused, ORIGIN)).toEqual({ ok: false, reason: 'id_taken' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({ [clip.id]: clip });
    expect(readTimelineDocument(doc).sources).toEqual({ [source.id]: source });
  });

  it.each([
    { sourceInFrame: 1 },
    { durationFrames: 49 },
    { startFrame: Number.MAX_SAFE_INTEGER },
  ])('refuses a semantically invalid range without writing: %s', (changedFields) => {
    const doc = seededDoc();
    const command = addVideo({ ...clip, ...changedFields }, OFF, source);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applyTimelineEdit(doc, command, ORIGIN)).toEqual({ ok: false, reason: 'invalid_range' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readTimelineDocument(doc).clips).toEqual({});
    expect(readTimelineDocument(doc).sources).toEqual({});
  });

  it('refuses an unavailable source without writing: source_unavailable for an addition, missing_source for an existing clip', () => {
    const missingSourceId = '10000000-0000-4000-8000-000000000009';
    const added = seededDoc();
    expect(applyTimelineEdit(added, add, ORIGIN).ok).toBe(true);
    const addedBytes = Y.encodeStateAsUpdate(added);
    const mismatched = addVideo({ ...clip, id: cid(9), startFrame: 48, sourceId: missingSourceId }, OFF, SHORT_SOURCE);
    expect(applyTimelineEdit(added, mismatched, ORIGIN)).toEqual({ ok: false, reason: 'source_unavailable' });
    expect(Y.encodeStateAsUpdate(added)).toEqual(addedBytes);

    const sourceless = docFrom(timeline([fixtureClip(cid(8), V2, 0, 10, { sourceId: missingSourceId })]));
    const sourcelessBytes = Y.encodeStateAsUpdate(sourceless);
    const updates = vi.fn();
    sourceless.on('update', updates);
    // An existing clip without its source is refused as missing_source (inner#1708 P1); source_unavailable is for additions.
    expect(applyTimelineEdit(sourceless, move(cid(8), 100, ON), ORIGIN)).toEqual({ ok: false, reason: 'missing_source' });
    expect(applyTimelineEdit(sourceless, setRange(cid(8), 0, 0, 5, ON), ORIGIN)).toEqual({ ok: false, reason: 'missing_source' });
    expect(updates).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(sourceless)).toEqual(sourcelessBytes);
  });

  it('keeps independent fields of a nested clip when clients merge', () => {
    const base = seededDoc();
    applyTimelineEdit(base, add, ORIGIN);
    const bytes = Y.encodeStateAsUpdate(base);
    const first = trackedDoc(bytes);
    const second = trackedDoc(bytes);
    applyTimelineEdit(first, move(clip.id, 96, OFF), ORIGIN);
    const secondClip = second.getMap<Y.Map<unknown>>('clips').get(clip.id);
    if (secondClip === undefined) throw new Error('The fixture clip is missing');
    secondClip.set('gain', 0.5);
    Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
    expect(readTimelineDocument(first).clips[clip.id]).toEqual({ ...clip, startFrame: 96, gain: 0.5 });
  });

  it('refuses repeated additions of the same clip identity without changing accepted bytes', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 10000 }), fc.boolean(), (count, startFrame, magnet) => {
      const doc = seededDoc();
      const command = addVideo({ ...clip, startFrame }, { magnet, linkage: true }, source);
      expect(applyTimelineEdit(doc, command, ORIGIN).ok).toBe(true);
      const bytes = Y.encodeStateAsUpdate(doc);
      for (let attempt = 0; attempt < count; attempt += 1) expect(applyTimelineEdit(doc, command, ORIGIN)).toEqual({ ok: false, reason: 'id_taken' });
      expect(Object.keys(readTimelineDocument(doc).clips)).toEqual([clip.id]);
      expect(readTimelineDocument(doc).sources).toEqual({ [source.id]: source });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    }));
  });

  it('preserves both locally accepted clips and sources in either merge order', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1000 }), (startFrame) => {
      const initial = Y.encodeStateAsUpdate(seededDoc());
      const first = trackedDoc(initial);
      const second = trackedDoc(initial);
      const secondSource = { ...source, id: '10000000-0000-4000-8000-000000000002' };
      const secondClip = { ...clip, id: '30000000-0000-4000-8000-000000000002', sourceId: secondSource.id, startFrame };
      applyTimelineEdit(first, addVideo({ ...clip, startFrame }, OFF, source), ORIGIN);
      applyTimelineEdit(second, addVideo(secondClip, OFF, secondSource), OTHER_ORIGIN);
      sync(first, second);
      expect(readTimelineDocument(first)).toEqual(readTimelineDocument(second));
      expect(readTimelineDocument(first).clips).toEqual({ [clip.id]: { ...clip, startFrame }, [secondClip.id]: secondClip });
      expect(readTimelineDocument(first).sources).toEqual({ [source.id]: source, [secondSource.id]: secondSource });
      expect(TimelineDocumentV1Schema.safeParse(readTimelineDocument(first)).success).toBe(true);
    }));
  });
});

describe('Timeline edits write only changed fields', () => {
  const A = cid(1);
  const B = cid(2);
  const C = cid(3);
  const O = cid(4);
  const base = timeline([fixtureClip(A, MAIN, 0, 48), fixtureClip(B, MAIN, 48, 24), fixtureClip(C, MAIN, 72, 48), fixtureClip(O, V2, 50, 10)]);

  it('sets only the trimmed field of a last clip and keeps every clip map instance', () => {
    const doc = docFrom(base);
    const instances = Object.keys(base.clips).map((id) => doc.getMap('clips').get(id));
    const changes = recordChanges(doc);
    accepted(applyTimelineEdit(doc, setRange(C, 72, 0, 20, ON), ORIGIN));
    expect(changes).toEqual([`clips/${C}:durationFrames`]);
    for (const [index, id] of Object.keys(base.clips).entries()) expect(doc.getMap('clips').get(id)).toBe(instances[index]);
  });

  it('sets only the shifted starts in a magnetic ripple', () => {
    const doc = docFrom(base);
    const changes = recordChanges(doc);
    accepted(applyTimelineEdit(doc, setRange(A, 0, 0, 30, ON), ORIGIN));
    expect(changes.sort()).toEqual([`clips/${A}:durationFrames`, `clips/${B}:startFrame`, `clips/${C}:startFrame`, `clips/${O}:startFrame`].sort());
  });

  it('deletes keys for removed clips and leaves sources untouched', () => {
    const doc = docFrom(base);
    const changes = recordChanges(doc);
    accepted(applyTimelineEdit(doc, { operation: 'delete', parameters: { clipId: B }, placement: ON }, ORIGIN));
    expect(changes.sort()).toEqual([`clips:${B}`, `clips:${O}`, `clips/${C}:startFrame`].sort());
    expect(readTimelineDocument(doc).sources).toEqual(base.sources);
  });

  it('attaches a new clip as one key and re-sets the existing source it references (inner#1708 L4)', () => {
    const doc = docFrom(base);
    const changes = recordChanges(doc);
    accepted(applyTimelineEdit(doc, addVideo(fixtureClip(cid(5), V2, 200, 10), ON), ORIGIN));
    expect(changes.sort()).toEqual([`clips:${cid(5)}`, `sources:${SOURCE.id}`].sort());
    expect(readTimelineDocument(doc).sources).toEqual(base.sources);
    expect(doc.getMap('clips').get(cid(5))).toBeInstanceOf(Y.Map);
  });

  it('writes exactly the planned difference for random accepted edits and nothing for refusals', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 200 }), fc.integer({ min: 1, max: 60 }), fc.boolean(), fc.boolean(),
      (operation, pick, frame, length, magnet, linkage) => {
        const doc = docFrom(base);
        const before = readTimelineDocument(doc);
        const bytes = Y.encodeStateAsUpdate(doc);
        const placement = { magnet, linkage };
        const subject = [A, B, C, O][pick] ?? A;
        const commands: TimelineEditCommand[] = [
          move(subject, frame, placement, frame % 2 === 0 ? { trackId: V2 } : {}),
          setRange(subject, before.clips[subject]?.startFrame ?? 0, frame % 40, length, placement),
          { operation: 'split', parameters: { clipId: subject, frame: (before.clips[subject]?.startFrame ?? 0) + (frame % 50), newClipId: cid(80) }, placement },
          { operation: 'duplicate', parameters: { clipId: subject, newClipId: cid(81) }, placement },
          { operation: 'delete', parameters: { clipId: subject }, placement },
        ];
        const command = commands[operation] ?? move(subject, frame, placement);
        const changes = recordChanges(doc);
        const origins: unknown[] = [];
        doc.on('afterTransaction', (transaction: Y.Transaction) => origins.push(transaction.origin));
        const plan = applyTimelineEdit(doc, command, ORIGIN, idFactory());
        if (!plan.ok) {
          expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
          expect(changes).toEqual([]);
          return;
        }
        if (sameRecords(before, plan.next)) {
          // A plan that changes no record writes nothing (inner#1708 H5, N1).
          expect(origins).toEqual([]);
          expect(changes).toEqual([]);
          expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
          return;
        }
        expect(origins).toEqual([ORIGIN]);
        expect(readTimelineDocument(doc)).toEqual(plan.next);
        expect(changes.sort()).toEqual(expectedChanges(before, plan.next));
      },
    ), { numRuns: 200 });
  });
});

describe('Timeline personal undo', () => {
  const A = cid(1);
  const B = cid(2);
  const C = cid(3);
  const O = cid(4);
  const base = timeline([fixtureClip(A, MAIN, 0, 48), fixtureClip(B, MAIN, 48, 24), fixtureClip(C, MAIN, 72, 48), fixtureClip(O, V2, 50, 10)]);

  it('undoes a magnetic ripple that moved several clips in one step and redoes it', () => {
    const doc = docFrom(base);
    const undo = undoManager(doc, ORIGIN);
    const plan = accepted(applyTimelineEdit(doc, setRange(A, 0, 0, 30, ON), ORIGIN));
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(readTimelineDocument(doc)).toEqual(base);
    expect(undo.undoStack).toHaveLength(0);
    expect(undo.redoStack).toHaveLength(1);
    undo.redo();
    expect(readTimelineDocument(doc)).toEqual(plan.next);
  });

  it('undoes a linkage bump that created a track in one step', () => {
    const OA = cid(6);
    const OB = cid(7);
    const before = timeline([fixtureClip(A, MAIN, 0, 48), fixtureClip(B, MAIN, 48, 48), fixtureClip(OA, V2, 10, 60), fixtureClip(OB, V2, 70, 10)]);
    const doc = docFrom(before);
    const undo = undoManager(doc, ORIGIN);
    const plan = accepted(applyTimelineEdit(doc, setRange(A, 0, 0, 20, ON), ORIGIN, idFactory('50000000')));
    expect(plan.bumped).toEqual([OB]);
    expect(Object.keys(readTimelineDocument(doc).tracks)).toHaveLength(3);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(readTimelineDocument(doc)).toEqual(before);
  });

  it('undoes an addition by removing the clip and the source it added (inner#1708 L5)', () => {
    const doc = docFrom(base);
    const undo = undoManager(doc, ORIGIN);
    accepted(applyTimelineEdit(doc, addVideo(fixtureClip(cid(5), V2, 200, 10, { sourceId: SHORT_SOURCE.id }), ON, SHORT_SOURCE), ORIGIN));
    undo.undo();
    const after = readTimelineDocument(doc);
    expect(after.clips).toEqual(base.clips);
    expect(after.sources).toEqual({ [SOURCE.id]: SOURCE });
  });

  it('does not track edits made under another origin', () => {
    const doc = docFrom(base);
    const undo = undoManager(doc, ORIGIN);
    accepted(applyTimelineEdit(doc, setRange(A, 0, 0, 30, ON), OTHER_ORIGIN));
    expect(undo.undoStack).toHaveLength(0);
  });

  it('keeps a field another replica wrote later when one replica undoes', () => {
    const bytes = Y.encodeStateAsUpdate(docFrom(base));
    const first = trackedDoc(bytes);
    const second = trackedDoc(bytes);
    const undo = undoManager(first, ORIGIN);
    accepted(applyTimelineEdit(first, move(O, 96, ON), ORIGIN));
    sync(first, second);
    accepted(applyTimelineEdit(second, move(O, 200, ON), OTHER_ORIGIN));
    const secondClip = second.getMap<Y.Map<unknown>>('clips').get(O);
    if (secondClip === undefined) throw new Error('The fixture clip is missing');
    secondClip.set('gain', 0.5);
    sync(first, second);
    undo.undo();
    sync(first, second);
    expect(readTimelineDocument(first).clips[O]).toMatchObject({ startFrame: 200, gain: 0.5 });
    expect(readTimelineDocument(second)).toEqual(readTimelineDocument(first));
  });

  it('restores only the undoing replica\'s own field and keeps another replica\'s later field', () => {
    const bytes = Y.encodeStateAsUpdate(docFrom(base));
    const first = trackedDoc(bytes);
    const second = trackedDoc(bytes);
    const undo = undoManager(first, ORIGIN);
    accepted(applyTimelineEdit(first, move(O, 96, ON), ORIGIN));
    sync(first, second);
    const secondClip = second.getMap<Y.Map<unknown>>('clips').get(O);
    if (secondClip === undefined) throw new Error('The fixture clip is missing');
    secondClip.set('gain', 0.5);
    sync(first, second);
    undo.undo();
    expect(readTimelineDocument(first).clips[O]).toEqual({ ...base.clips[O], gain: 0.5 });
  });
});

describe('Timeline concurrent edits across two replicas', () => {
  const A = cid(1);
  const X = cid(2);
  const Y_ = cid(3);

  /**
   * Merge two replica updates into fresh documents in both orders.
   * @param initial - The common starting bytes.
   * @param left - The first replica.
   * @param right - The second replica.
   * @returns The two merged documents.
   * @throws {Error} When an update cannot be decoded.
   */
  function mergeBothOrders(initial: Uint8Array, left: Y.Doc, right: Y.Doc): [Y.Doc, Y.Doc] {
    const forward = trackedDoc(initial);
    Y.applyUpdate(forward, Y.encodeStateAsUpdate(left));
    Y.applyUpdate(forward, Y.encodeStateAsUpdate(right));
    const backward = trackedDoc(initial);
    Y.applyUpdate(backward, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(backward, Y.encodeStateAsUpdate(left));
    return [forward, backward];
  }

  /**
   * Resolve a document's arrangement with source ranges.
   * @param doc - The document.
   * @returns The arrangement.
   * @throws {Error} When the document cannot be read.
   */
  function arrange(doc: Y.Doc): ReturnType<typeof resolveTimelineArrangement> {
    const value = readTimelineDocument(doc);
    return resolveTimelineArrangement(value);
  }

  it('derives the same arrangement from concurrent main-track inserts in either order, and the next magnetic edit packs them', () => {
    const initial = Y.encodeStateAsUpdate(docFrom(timeline([fixtureClip(A, MAIN, 0, 48)])));
    const left = trackedDoc(initial);
    const right = trackedDoc(initial);
    accepted(applyTimelineEdit(left, addVideo(fixtureClip(X, MAIN, 48, 24), ON), ORIGIN));
    accepted(applyTimelineEdit(right, addVideo(fixtureClip(Y_, MAIN, 48, 24), ON), OTHER_ORIGIN));
    const [forward, backward] = mergeBothOrders(initial, left, right);
    expect(readTimelineDocument(forward)).toEqual(readTimelineDocument(backward));
    expect(arrange(forward)).toEqual(arrange(backward));
    expect(arrange(forward).conflicts.map((item) => item.clipId).sort()).toEqual([X, Y_].sort());

    accepted(applyTimelineEdit(forward, { operation: 'split', parameters: { clipId: A, frame: 24, newClipId: cid(9) }, placement: ON }, ORIGIN));
    expect(starts(readTimelineDocument(forward), MAIN)).toEqual([[A, 0, 24], [cid(9), 24, 24], [X, 48, 24], [Y_, 72, 24]]);
    expect(arrange(forward).hasConflicts).toBe(false);
  });

  it('keeps a clip moved into a concurrently deleted track as missing_track, and resolves it by moving to an existing track', () => {
    const B = cid(4);
    const initial = Y.encodeStateAsUpdate(docFrom(timeline([fixtureClip(A, MAIN, 0, 48), fixtureClip(B, MAIN, 48, 24)])));
    const left = trackedDoc(initial);
    const right = trackedDoc(initial);
    accepted(applyTimelineEdit(left, { operation: 'delete_track', parameters: { trackId: V2 }, placement: ON }, ORIGIN));
    accepted(applyTimelineEdit(right, move(B, 100, ON, { trackId: V2 }), OTHER_ORIGIN));
    const [forward, backward] = mergeBothOrders(initial, left, right);
    for (const doc of [forward, backward]) {
      const value = readTimelineDocument(doc);
      expect(value.clips[B]).toMatchObject({ trackId: V2, startFrame: 100 });
      expect(value.tracks[V2]).toBeUndefined();
      expect(arrange(doc).conflicts).toEqual([expect.objectContaining({ clipId: B, reasons: [expect.objectContaining({ code: 'missing_track' })] })]);
    }
    expect(readTimelineDocument(forward)).toEqual(readTimelineDocument(backward));
    expect(planTimelineEdit(readTimelineDocument(forward), { operation: 'delete', parameters: { clipId: B }, placement: ON }, idFactory()).ok).toBe(true);
    accepted(applyTimelineEdit(forward, move(B, 100, ON, { trackId: MAIN }), ORIGIN));
    expect(arrange(forward).hasConflicts).toBe(false);
    expect(starts(readTimelineDocument(forward), MAIN)).toEqual([[A, 0, 48], [B, 48, 24]]);
  });

  it('derives invalid_range for an out-of-source clip left by concurrent trims and a partial undo', () => {
    const K = cid(5);
    const initial = Y.encodeStateAsUpdate(docFrom(timeline([fixtureClip(K, MAIN, 0, 24, { sourceId: SHORT_SOURCE.id, sourceInFrame: 24 })], undefined, [SHORT_SOURCE])));
    const left = trackedDoc(initial);
    const right = trackedDoc(initial);
    const undo = undoManager(left, ORIGIN);
    accepted(applyTimelineEdit(left, setRange(K, 0, 0, 24, ON), ORIGIN));
    sync(left, right);
    accepted(applyTimelineEdit(right, setRange(K, 0, 0, 48, ON), OTHER_ORIGIN));
    sync(left, right);
    undo.undo();
    sync(left, right);
    for (const doc of [left, right]) {
      const value = readTimelineDocument(doc);
      expect(value.clips[K]).toMatchObject({ sourceInFrame: 24, durationFrames: 48 });
      expect(arrange(doc).conflicts).toEqual([expect.objectContaining({ clipId: K, reasons: [expect.objectContaining({ code: 'invalid_range' })] })]);
    }
    const bytes = Y.encodeStateAsUpdate(left);
    expect(applyTimelineEdit(left, setRange(K, 0, 24, 60, ON), ORIGIN)).toEqual({ ok: false, reason: 'invalid_range' });
    expect(applyTimelineEdit(left, setRange(K, 0, 20, 48, ON), ORIGIN)).toEqual({ ok: false, reason: 'invalid_range' });
    expect(Y.encodeStateAsUpdate(left)).toEqual(bytes);
    accepted(applyTimelineEdit(left, setRange(K, 0, 0, 48, ON), ORIGIN));
    expect(arrange(left).hasConflicts).toBe(false);
  });
});

describe('Removing damaged records and the read entry (inner#1708 F1b)', () => {
  const BAD_CLIP = '30000000-0000-4000-8000-0000000000bd';
  const BAD_TRACK = 'track-damaged';

  /**
   * A document holding one valid clip, a clip record missing most fields and a track record missing its kind.
   * @returns The document.
   * @throws {Error} When seeding fails.
   */
  function damagedDoc(): Y.Doc {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add, ORIGIN).ok).toBe(true);
    doc.transact(() => {
      const partialClip = new Y.Map<unknown>();
      doc.getMap('clips').set(BAD_CLIP, partialClip);
      partialClip.set('startFrame', 100);
      const partialTrack = new Y.Map<unknown>();
      doc.getMap('tracks').set(BAD_TRACK, partialTrack);
      partialTrack.set('order', 3);
    }, 'peer');
    return doc;
  }

  it('removes one damaged clip record in one transaction with the given origin (inner#1708 N2)', () => {
    const doc = damagedDoc();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => { origins.push(transaction.origin); });
    removeTimelineClip(doc, BAD_CLIP, ORIGIN);
    expect(origins).toEqual([ORIGIN]);
    expect(doc.getMap('clips').has(BAD_CLIP)).toBe(false);
    expect(doc.getMap('clips').has(clip.id)).toBe(true);
    expect(readTimelineContent(doc).damaged).toEqual({ clips: [] });
    expect(readTimelineContent(doc).document.tracks[BAD_TRACK]).toBe(undefined);
  });

  it('reads through the shared space-content entry that integration tests use, and edits only in web', () => {
    expect(typeof spaceContent.readTimelineContent).toBe('function');
    expect(typeof spaceContent.readTimelineDocument).toBe('function');
    expect(readTimelineContent).toBe(spaceContent.readTimelineContent);
    expect(readTimelineDocument).toBe(spaceContent.readTimelineDocument);
    expect(sharedIndex).not.toHaveProperty('planTimelineEdit');
  });
});

/**
 * The source ids every record in the clips map references, valid or damaged, as long as `sourceId` is a string.
 * @param doc - The content document.
 * @returns The sorted ids.
 * @throws {never} Never.
 */
function referencedSources(doc: Y.Doc): string[] {
  const ids = new Set<string>();
  for (const record of doc.getMap('clips').values()) {
    const sourceId = record instanceof Y.Map ? record.get('sourceId') : undefined;
    if (typeof sourceId === 'string') ids.add(sourceId);
  }
  return [...ids].sort();
}

/**
 * The stored source ids.
 * @param doc - The content document.
 * @returns The sorted ids.
 * @throws {never} Never.
 */
function storedSources(doc: Y.Doc): string[] {
  return [...doc.getMap('sources').keys()].sort();
}

/**
 * Write a clip record that misses most fields but still names its source.
 * @param doc - The content document.
 * @param id - The record id.
 * @param sourceId - The source it names.
 * @throws {Error} When Yjs cannot attach the map.
 */
function damagedClip(doc: Y.Doc, id: string, sourceId: string): void {
  doc.transact(() => {
    const record = new Y.Map<unknown>();
    doc.getMap('clips').set(id, record);
    record.set('sourceId', sourceId);
    record.set('startFrame', 5);
  }, 'peer');
}

/**
 * Record each transaction's origin and whether it changed the sources map.
 * @param doc - The content document.
 * @returns The live list.
 * @throws {never} Never.
 */
function recordTransactions(doc: Y.Doc): Array<{ origin: unknown; sources: boolean }> {
  const seen: Array<{ origin: unknown; sources: boolean }> = [];
  // Compared by identity only, so the map is held as unknown.
  const sources: unknown = doc.getMap('sources');
  doc.on('afterTransaction', (transaction: Y.Transaction) => { seen.push({ origin: transaction.origin, sources: [...transaction.changed.keys()].some((type) => type === sources) }); });
  return seen;
}

describe('Timeline edits sweep unreferenced sources (inner#1708 L2)', () => {
  const X = cid(51);
  const Y2 = cid(52);

  it('deletes the source of the last clip that referenced it in the edit transaction', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10), fixtureClip(Y2, V2, 100, 10, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]));
    const seen = recordTransactions(doc);
    accepted(applyTimelineEdit(doc, { operation: 'delete', parameters: { clipId: Y2 }, placement: OFF }, ORIGIN));
    expect(seen).toEqual([{ origin: ORIGIN, sources: true }]);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });

  it('sweeps an orphan left in an older document during an unrelated move', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)]));
    doc.transact(() => doc.getMap('sources').set(SHORT_SOURCE.id, SHORT_SOURCE), 'setup');
    const seen = recordTransactions(doc);
    accepted(applyTimelineEdit(doc, move(X, 100, OFF), ORIGIN));
    expect(seen).toEqual([{ origin: ORIGIN, sources: true }]);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });

  it('keeps the source a damaged clip record still names', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)], undefined, [SOURCE, SHORT_SOURCE]));
    damagedClip(doc, cid(59), SHORT_SOURCE.id);
    accepted(applyTimelineEdit(doc, move(X, 100, OFF), ORIGIN));
    expect(storedSources(doc)).toEqual([SOURCE.id, SHORT_SOURCE.id].sort());
    expect(storedSources(doc)).toEqual(referencedSources(doc));
  });

  it('leaves exactly the referenced sources after every kind of accepted edit', () => {
    const commands: TimelineEditCommand[] = [
      move(X, 100, OFF), setRange(X, 0, 0, 5, OFF), addVideo(fixtureClip(cid(53), V2, 300, 10), OFF),
      { operation: 'split', parameters: { clipId: X, frame: 5, newClipId: cid(54) }, placement: OFF },
      { operation: 'duplicate', parameters: { clipId: X, newClipId: cid(55) }, placement: OFF },
      { operation: 'delete', parameters: { clipId: X }, placement: OFF },
      { operation: 'delete_track', parameters: { trackId: 'v3' }, placement: OFF },
    ];
    for (const command of commands) {
      const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)], [{ id: MAIN, kind: 'visual', order: 0 }, { id: V2, kind: 'visual', order: 1 }, { id: 'v3', kind: 'visual', order: 2 }]));
      doc.transact(() => doc.getMap('sources').set(SHORT_SOURCE.id, SHORT_SOURCE), 'setup');
      accepted(applyTimelineEdit(doc, command, ORIGIN));
      expect(storedSources(doc), command.operation).toEqual(referencedSources(doc));
    }
  });
});

describe('Removing a clip record and its source (inner#1708 L3, N2)', () => {
  const X = cid(61);
  const Y2 = cid(62);
  const DAMAGED = cid(63);

  it('deletes the source only the removed damaged record named, in the same transaction', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)], undefined, [SOURCE, SHORT_SOURCE]));
    damagedClip(doc, DAMAGED, SHORT_SOURCE.id);
    const seen = recordTransactions(doc);
    removeTimelineClip(doc, DAMAGED, ORIGIN);
    expect(seen).toEqual([{ origin: ORIGIN, sources: true }]);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });

  it('keeps the source another valid clip still references', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10), fixtureClip(Y2, V2, 100, 10)]));
    removeTimelineClip(doc, X, ORIGIN);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });

  it('keeps the source a damaged record still names', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10), fixtureClip(Y2, V2, 100, 10, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]));
    damagedClip(doc, DAMAGED, SHORT_SOURCE.id);
    removeTimelineClip(doc, Y2, ORIGIN);
    expect(storedSources(doc)).toEqual([SOURCE.id, SHORT_SOURCE.id].sort());
  });

  it('opens no transaction for an absent clip, even with an orphan source present', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)], undefined, [SOURCE, SHORT_SOURCE]));
    const seen = recordTransactions(doc);
    let updates = 0;
    doc.on('update', () => { updates += 1; });
    removeTimelineClip(doc, cid(64), ORIGIN);
    expect(seen).toEqual([]);
    expect(updates).toBe(0);
    expect(storedSources(doc)).toEqual([SOURCE.id, SHORT_SOURCE.id].sort());
  });

  it('adds no undo step for an absent clip', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)], undefined, [SOURCE, SHORT_SOURCE]));
    const undo = undoManager(doc, ORIGIN);
    removeTimelineClip(doc, cid(64), ORIGIN);
    expect(undo.undoStack).toHaveLength(0);
  });
});

describe('Edits that create clips re-set their sources against a concurrent sweep (inner#1708 L4)', () => {
  const X = cid(71);
  const W = cid(72);
  const Z = cid(73);
  const PART = cid(74);

  /**
   * Run a clip-creating edit on one replica while the other deletes the last clip naming SHORT_SOURCE, then merge.
   * @param start - The common starting document.
   * @param create - The creating edit on the first replica.
   * @param createdId - The clip the creating edit makes.
   * @param lastReference - The clip the other replica deletes.
   * @throws {Error} When an edit is refused or a replica breaks the contract.
   */
  function race(start: TimelineDocumentV1, create: TimelineEditCommand, createdId: string, lastReference: string): void {
    const bytes = Y.encodeStateAsUpdate(docFrom(start));
    const mine = trackedDoc(bytes);
    const peer = trackedDoc(bytes);
    const changes = recordChanges(mine);
    accepted(applyTimelineEdit(mine, create, ORIGIN, idFactory('41111111')));
    expect(changes, 'the creating edit re-sets the source').toContain(`sources:${SHORT_SOURCE.id}`);
    accepted(applyTimelineEdit(peer, { operation: 'delete', parameters: { clipId: lastReference }, placement: OFF }, OTHER_ORIGIN));
    expect(storedSources(peer), 'the peer sweeps the unreferenced source').not.toContain(SHORT_SOURCE.id);
    sync(mine, peer);
    for (const doc of [mine, peer]) {
      const document = readTimelineDocument(doc);
      expect(document.sources[SHORT_SOURCE.id]).toEqual(SHORT_SOURCE);
      expect(document.clips[createdId]?.sourceId).toBe(SHORT_SOURCE.id);
    }
    expect(readTimelineDocument(mine)).toEqual(readTimelineDocument(peer));
  }

  it('keeps the source for a clip added from it', () => {
    race(timeline([fixtureClip(X, V2, 0, 10, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]),
      addVideo(fixtureClip(Z, V2, 200, 10, { sourceId: SHORT_SOURCE.id }), OFF, SHORT_SOURCE), Z, X);
  });

  it('keeps the source for the right part of a split', () => {
    race(timeline([fixtureClip(X, V2, 0, 40, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]),
      { operation: 'split', parameters: { clipId: X, frame: 20, newClipId: PART }, placement: OFF }, PART, X);
  });

  it('keeps the source for a duplicate', () => {
    race(timeline([fixtureClip(X, V2, 0, 40, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE, SHORT_SOURCE]),
      { operation: 'duplicate', parameters: { clipId: X, newClipId: PART }, placement: OFF }, PART, X);
  });

  it('keeps the source for the right part an overwrite cuts from a covered clip', () => {
    // Moving W onto V2 at 10 with the magnet off covers the middle of X; the cut right part keeps X's source.
    const start = timeline([fixtureClip(X, V2, 0, 48, { sourceId: SHORT_SOURCE.id }), fixtureClip(W, MAIN, 0, 10)], undefined, [SOURCE, SHORT_SOURCE]);
    const probe = accepted(planTimelineEdit(start, move(W, 10, OFF, { trackId: V2 }), idFactory('41111111')));
    const cut = probe.created[0];
    if (cut === undefined) throw new Error('The overwrite cut no right part');
    race(start, move(W, 10, OFF, { trackId: V2 }), cut, X);
  });

  it('writes nothing to sources for an edit that creates no clip', () => {
    for (const command of [move(X, 100, OFF), setRange(X, 0, 0, 20, OFF)]) {
      const doc = docFrom(timeline([fixtureClip(X, V2, 0, 40, { sourceId: SHORT_SOURCE.id })], undefined, [SHORT_SOURCE]));
      const seen = recordTransactions(doc);
      accepted(applyTimelineEdit(doc, command, ORIGIN));
      expect(seen, command.operation).toEqual([{ origin: ORIGIN, sources: false }]);
    }
  });
});

describe('timelineClipSourceId (inner#1708 Q2)', () => {
  it('reads a string sourceId from an attached record map', () => {
    const doc = trackedDoc();
    const record = new Y.Map<unknown>();
    doc.getMap('clips').set('x', record);
    record.set('sourceId', SOURCE.id);
    expect(timelineClipSourceId(record)).toBe(SOURCE.id);
  });

  it('reads a string sourceId from a plain object record', () => {
    expect(timelineClipSourceId({ sourceId: SOURCE.id, startFrame: 5 })).toBe(SOURCE.id);
  });

  it.each([
    ['a missing sourceId', { startFrame: 5 }],
    ['a numeric sourceId', { sourceId: 7 }],
    ['null', null],
    ['a string', SOURCE.id],
    ['a number', 7],
    ['undefined', undefined],
  ])('returns undefined for %s', (_name, record) => {
    expect(timelineClipSourceId(record)).toBe(undefined);
  });

  it('returns undefined for a record map without a string sourceId', () => {
    const doc = trackedDoc();
    const record = new Y.Map<unknown>();
    doc.getMap('clips').set('x', record);
    record.set('sourceId', 3);
    expect(timelineClipSourceId(record)).toBe(undefined);
  });
});

describe('An accepted plan that changes nothing writes nothing (inner#1708 H5)', () => {
  const X = cid(97);

  it.each([
    ['a move to the current start', move(X, 0, OFF)],
    ['a set_range to the current range', setRange(X, 0, 0, 10, OFF)],
  ])('opens no transaction for %s, even with an orphan source present', (_name, command) => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)], undefined, [SOURCE, SHORT_SOURCE]));
    const before = Y.encodeStateAsUpdate(doc);
    let transactions = 0;
    let updates = 0;
    doc.on('afterTransaction', () => { transactions += 1; });
    doc.on('update', () => { updates += 1; });
    expect(applyTimelineEdit(doc, command, ORIGIN).ok).toBe(true);
    expect(transactions).toBe(0);
    expect(updates).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(storedSources(doc)).toEqual([SOURCE.id, SHORT_SOURCE.id].sort());
  });
});

describe('A no-op edit is compared record by record, whatever the key order (inner#1708 N1)', () => {
  const FIRST = cid(98);
  const SECOND = cid(99);

  it.each([
    ['a sub-track move of a clip that is not the last key', [fixtureClip(FIRST, V2, 0, 10), fixtureClip(SECOND, V2, 40, 10)], move(FIRST, 0, OFF)],
    ['a magnetic main-track move of a clip that is not the last key', [fixtureClip(FIRST, MAIN, 0, 10), fixtureClip(SECOND, MAIN, 10, 10)], move(FIRST, 0, ON)],
    ['a set_range to the current range of a clip that is not the last key', [fixtureClip(FIRST, V2, 0, 10), fixtureClip(SECOND, V2, 40, 10)], setRange(FIRST, 0, 0, 10, OFF)],
  ] as const)('opens no transaction for %s, with an orphan source present', (_name, clips, command) => {
    const doc = docFrom(timeline([...clips], undefined, [SOURCE, SHORT_SOURCE]));
    const before = Y.encodeStateAsUpdate(doc);
    let transactions = 0;
    doc.on('afterTransaction', () => { transactions += 1; });
    expect(applyTimelineEdit(doc, command, ORIGIN).ok).toBe(true);
    expect(transactions).toBe(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(storedSources(doc)).toEqual([SOURCE.id, SHORT_SOURCE.id].sort());
  });
});

describe('applyTimelineEdit refuses structurally invalid command values instead of throwing (inner#1708 P3)', () => {
  const X = cid(100);

  it.each([
    ['a start past the largest safe integer', move(X, Number.MAX_SAFE_INTEGER + 1, OFF)],
    ['a fractional start', move(X, 0.5, OFF)],
    ['a negative start', move(X, -1, OFF)],
    ['a zero duration', setRange(X, 0, 0, 0, OFF)],
  ] as const)('returns invalid_range and writes nothing for %s', (_name, command) => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)]));
    const before = Y.encodeStateAsUpdate(doc);
    let result: ReturnType<typeof applyTimelineEdit> | undefined;
    expect(() => { result = applyTimelineEdit(doc, command, ORIGIN); }).not.toThrow();
    expect(result).toEqual({ ok: false, reason: 'invalid_range' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('missingTimelineSourceIds (inner#1708 Q2)', () => {
  const X = cid(120);
  const Y2 = cid(121);
  const OTHER_SOURCE_ID = '10000000-0000-4000-8000-0000000000ee';
  const UNKNOWN_SOURCE_ID = '10000000-0000-4000-8000-0000000000dd';

  it('lists referenced sources, damaged records included, that are missing and have a known value', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10), fixtureClip(Y2, V2, 100, 10, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE]));
    damagedClip(doc, cid(122), OTHER_SOURCE_ID);
    damagedClip(doc, cid(123), UNKNOWN_SOURCE_ID);
    const values = { [SOURCE.id]: SOURCE, [SHORT_SOURCE.id]: SHORT_SOURCE, [OTHER_SOURCE_ID]: { ...SOURCE, id: OTHER_SOURCE_ID } };
    expect([...missingTimelineSourceIds(doc, values)].sort()).toEqual([SHORT_SOURCE.id, OTHER_SOURCE_ID].sort());
  });

  it('is empty when every referenced source is stored', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)]));
    expect(missingTimelineSourceIds(doc, { [SOURCE.id]: SOURCE, [SHORT_SOURCE.id]: SHORT_SOURCE })).toEqual([]);
  });

  it('is empty when no missing source has a known value', () => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10, { sourceId: SHORT_SOURCE.id })], undefined, [SOURCE]));
    expect(missingTimelineSourceIds(doc, { [SOURCE.id]: SOURCE })).toEqual([]);
  });
});

describe('Clip records naming an Object.prototype key as their source (inner#1708 R2)', () => {
  const X = cid(140);
  const Y2 = cid(141);
  const ODD = cid(142);
  const NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__'] as const;

  it.each(NAMES)('edits and removes other clips completely next to a record naming %s', (name) => {
    const doc = docFrom(timeline([fixtureClip(X, MAIN, 0, 20), fixtureClip(Y2, MAIN, 20, 20)]));
    damagedClip(doc, ODD, name);
    expect(() => applyTimelineEdit(doc, move(X, 60, OFF), ORIGIN)).not.toThrow();
    expect(readTimelineDocument(doc).clips[X]?.startFrame).toBe(60);
    expect(() => removeTimelineClip(doc, Y2, ORIGIN)).not.toThrow();
    expect(doc.getMap('clips').has(Y2)).toBe(false);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
    expect(() => removeTimelineClip(doc, ODD, ORIGIN)).not.toThrow();
    expect(doc.getMap('clips').has(ODD)).toBe(false);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });

  it.each(NAMES)('finds no missing source for a record naming %s, whatever values inherit', (name) => {
    const doc = docFrom(timeline([fixtureClip(X, MAIN, 0, 20)]));
    damagedClip(doc, ODD, name);
    expect(missingTimelineSourceIds(doc, {})).toEqual([]);
    expect(missingTimelineSourceIds(doc, { [SOURCE.id]: SOURCE })).toEqual([]);
  });
});

describe('Edits around a source that cannot be read (inner#1708 F1)', () => {
  const X = cid(170);
  const BAD = cid(171);
  const BAD_SOURCE = '10000000-0000-4000-8000-0000000000a9';
  const BAD_VALUES = [
    ['a number', 42],
    ['a record missing fields', { id: BAD_SOURCE, kind: 'video' }],
    ['a valid source stored under another key', { ...SOURCE, id: '10000000-0000-4000-8000-0000000000b9' }],
  ] as const;

  it.each(BAD_VALUES)('reads, edits and sweeps an unreferenced source stored as %s', (_name, value) => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10)]));
    doc.transact(() => doc.getMap('sources').set(BAD_SOURCE, value), 'peer');
    expect(() => readTimelineDocument(doc)).not.toThrow();
    expect(readTimelineDocument(doc).sources).toEqual({ [SOURCE.id]: SOURCE });
    expect(applyTimelineEdit(doc, move(X, 40, OFF), ORIGIN).ok).toBe(true);
    expect(readTimelineDocument(doc).clips[X]?.startFrame).toBe(40);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });

  it.each(BAD_VALUES)('flags, edits around and sweeps with its clip a referenced source stored as %s', (_name, value) => {
    const doc = docFrom(timeline([fixtureClip(X, V2, 0, 10), fixtureClip(BAD, V2, 50, 10, { sourceId: BAD_SOURCE })]));
    doc.transact(() => doc.getMap('sources').set(BAD_SOURCE, value), 'peer');
    expect(() => readTimelineDocument(doc)).not.toThrow();
    const conflict = resolveTimelineArrangement(readTimelineDocument(doc)).conflicts.find((item) => item.clipId === BAD);
    expect(conflict?.reasons.map((reason) => reason.code)).toContain('missing_source');
    expect(applyTimelineEdit(doc, move(X, 30, OFF), ORIGIN).ok).toBe(true);
    expect(readTimelineDocument(doc).clips[X]?.startFrame).toBe(30);
    expect(applyTimelineEdit(doc, { operation: 'delete', parameters: { clipId: BAD }, placement: OFF }, ORIGIN).ok).toBe(true);
    expect(doc.getMap('clips').has(BAD)).toBe(false);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });
});

describe('A clip record stored under a key other than its id (inner#1708 Q1)', () => {
  const A = cid(190);
  const B = cid(191);
  const C = cid(192);
  const KEY = cid(193);

  /**
   * Main A[0,10), a record for clip B at [10,20) stored under KEY, and C[20,30).
   * @returns The document.
   * @throws {Error} When Yjs cannot attach the map.
   */
  function misfiled(): Y.Doc {
    const doc = docFrom(timeline([fixtureClip(A, MAIN, 0, 10), fixtureClip(C, MAIN, 20, 10)], undefined, [SOURCE, SHORT_SOURCE]));
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(KEY, record);
      for (const [name, value] of Object.entries(fixtureClip(B, MAIN, 10, 10, { sourceId: SHORT_SOURCE.id }))) record.set(name, value);
    }, 'peer');
    return doc;
  }

  it('reads it as damaged, not as a clip', () => {
    const content = readTimelineContent(misfiled());
    expect(content.damaged.clips).toEqual([KEY]);
    expect(content.document.clips[B]).toBe(undefined);
    expect(content.document.clips[KEY]).toBe(undefined);
    expect(resolveTimelineArrangement(content.document).readyClipIds).toEqual([A, C].sort());
  });

  it('removes it by its key and sweeps the source only it named', () => {
    const doc = misfiled();
    removeTimelineClip(doc, KEY, ORIGIN);
    expect(doc.getMap('clips').has(KEY)).toBe(false);
    expect(storedSources(doc)).toEqual([SOURCE.id]);
  });

  it('packs the magnetic main track without leaving its gap when another clip is deleted', () => {
    // A[0,10), the misfiled B at [30,40), C[40,50): deleting A must leave the ready main clips packed from frame 0.
    const doc = docFrom(timeline([fixtureClip(A, MAIN, 0, 10), fixtureClip(C, MAIN, 40, 10)]));
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(KEY, record);
      for (const [name, value] of Object.entries(fixtureClip(B, MAIN, 30, 10))) record.set(name, value);
    }, 'peer');
    expect(applyTimelineEdit(doc, { operation: 'delete', parameters: { clipId: A }, placement: ON }, ORIGIN).ok).toBe(true);
    const document = readTimelineDocument(doc);
    const ready = new Set(resolveTimelineArrangement(document).readyClipIds);
    let at = 0;
    for (const [id, startFrame, durationFrames] of starts(document, MAIN)) {
      if (!ready.has(id)) continue;
      expect(startFrame, `ready main clip ${id}`).toBe(at);
      at += durationFrames;
    }
    expect(document.clips[C]?.startFrame).toBe(0);
    expect(doc.getMap('clips').has(B)).toBe(false);
  });
});

describe('missingTimelineSourceIds counts an unreadable stored value as missing (inner#1708 Q2)', () => {
  it.each([
    ['a record with only its id', { id: SOURCE.id }],
    ['a number', 42],
  ] as const)('lists a referenced source stored as %s', (_name, value) => {
    const doc = docFrom(timeline([fixtureClip(cid(195), V2, 0, 10)]));
    doc.transact(() => doc.getMap('sources').set(SOURCE.id, value), 'peer');
    expect(missingTimelineSourceIds(doc, { [SOURCE.id]: SOURCE })).toEqual([SOURCE.id]);
    expect(missingTimelineSourceIds(doc, {})).toEqual([]);
  });
});
