// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import * as sharedIndex from '@breatic/shared';
import * as spaceContent from '@breatic/shared/space-content';
import { initializeTimelineDocument } from '@breatic/shared/space-content';
import { applyTimelineEdit, readTimelineContent, readTimelineDocument, removeTimelineRecord } from '@web/data/yjs/timeline-document';
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
  return new Y.UndoManager([doc.getMap('tracks'), doc.getMap('clips')], { trackedOrigins: new Set([origin]), captureTimeout: 0 });
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
  for (const id of Object.keys(after.sources)) if (before.sources[id] === undefined) changes.push(`sources:${id}`);
  return changes.sort();
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

describe('Timeline document ownership and schema', () => {
  it('seeds a complete V1 with a single stable visual track', () => {
    const doc = seededDoc();
    expect(readTimelineDocument(doc)).toEqual({
      schemaVersion: 1,
      settings,
      tracks: { 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 } },
      clips: {},
      sources: {},
    });
    expect([...doc.share.keys()].sort()).toEqual(['clips', 'sources', 'timeline', 'tracks']);
    expect(doc.getMap('tracks').get('visual-1')).toBeInstanceOf(Y.Map);
    expect(TimelineDocumentV1Schema.parse(readTimelineDocument(doc))).toEqual(readTimelineDocument(doc));
  });

  it('reads the same persisted initial state in two independent clients', () => {
    const server = seededDoc();
    const bytes = Y.encodeStateAsUpdate(server);
    const first = trackedDoc(bytes);
    const second = trackedDoc(bytes);
    expect(readTimelineDocument(first)).toEqual(readTimelineDocument(second));
    expect(Y.encodeStateAsUpdate(first)).toEqual(bytes);
    expect(Y.encodeStateAsUpdate(second)).toEqual(bytes);
  });

  it('does not manufacture an initial document while reading empty or unsupported content', () => {
    const empty = trackedDoc();
    const emptyBytes = Y.encodeStateAsUpdate(empty);
    expect(() => readTimelineDocument(empty)).toThrow(Error);
    expect(Y.encodeStateAsUpdate(empty)).toEqual(emptyBytes);
    const unsupported = seededDoc();
    unsupported.getMap('timeline').set('schemaVersion', 2);
    const unsupportedBytes = Y.encodeStateAsUpdate(unsupported);
    expect(() => readTimelineDocument(unsupported)).toThrow(Error);
    expect(Y.encodeStateAsUpdate(unsupported)).toEqual(unsupportedBytes);
  });

  it('requires a strict integer-frame DTO rather than a third-party or URL-bearing source', () => {
    const doc = seededDoc();
    applyTimelineEdit(doc, add, ORIGIN);
    const value = readTimelineDocument(doc);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, settings: { ...settings, fps: { num: 24, den: 0 } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, clips: { [clip.id]: { ...clip, startFrame: 0.5 } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, sources: { [source.id]: { ...source, fileUrl: 'https://example.com/video.mp4' } } }).success).toBe(false);
    expect(TimelineDocumentV1Schema.safeParse({ ...value, vendorTimeline: {} }).success).toBe(false);
  });

  it('preserves existing content and non-empty delete sets when initialization is attempted', () => {
    const existing = seededDoc();
    applyTimelineEdit(existing, add, ORIGIN);
    const unknown = trackedDoc();
    unknown.getMap('legacy').set('retained', 'original content');
    const deleted = trackedDoc();
    deleted.getMap('legacy').set('removed', 'original content');
    deleted.getMap('legacy').delete('removed');
    expect(deleted.getMap('legacy').size).toBe(0);
    expect(Y.decodeUpdate(Y.encodeStateAsUpdate(deleted)).ds.clients.size).toBe(1);
    for (const doc of [existing, unknown, deleted]) {
      const before = Y.encodeStateAsUpdate(doc);
      try {
        initializeTimelineDocument(doc, { width: 1280, height: 720, fps: { num: 30, den: 1 } });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    }
    expect(readTimelineDocument(existing).settings).toEqual(settings);
    expect(readTimelineDocument(existing).clips[clip.id]).toEqual(clip);
    expect(unknown.getMap('legacy').get('retained')).toBe('original content');
  });

  it('rejects invalid settings before writing any part of the initial state', () => {
    const doc = trackedDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const updates = vi.fn();
    doc.on('update', updates);
    expect(() => initializeTimelineDocument(doc, { ...settings, fps: { num: 24, den: 0 } })).toThrow(Error);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(updates).not.toHaveBeenCalled();
  });

  it('does not seed a document holding only a pending delete set and no structs', () => {
    const origin = trackedDoc();
    origin.getMap('legacy').set('removed', 'retained deletion');
    const knownStructs = Y.encodeStateVector(origin);
    origin.getMap('legacy').delete('removed');
    const deletionOnly = Y.encodeStateAsUpdate(origin, knownStructs);
    expect(Y.decodeUpdate(deletionOnly).structs).toEqual([]);
    expect(Y.decodeUpdate(deletionOnly).ds.clients.size).toBe(1);
    const receiver = trackedDoc();
    Y.applyUpdate(receiver, deletionOnly);
    const before = Y.encodeStateAsUpdate(receiver);
    expect(Y.decodeUpdate(before).structs).toEqual([]);
    expect(Y.decodeUpdate(before).ds.clients.size).toBe(1);
    expect([...receiver.share.keys()]).toEqual([]);
    try {
      initializeTimelineDocument(receiver, settings);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(Y.encodeStateAsUpdate(receiver)).toEqual(before);
    expect([...receiver.share.keys()]).toEqual([]);
  });
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
    expect(plan.removed).toEqual([]);
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

  it('refuses an unavailable source without writing', () => {
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
    expect(applyTimelineEdit(sourceless, move(cid(8), 100, ON), ORIGIN)).toEqual({ ok: false, reason: 'source_unavailable' });
    expect(applyTimelineEdit(sourceless, setRange(cid(8), 0, 0, 5, ON), ORIGIN)).toEqual({ ok: false, reason: 'source_unavailable' });
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

  it('attaches a new clip as one key and does not rewrite an existing source', () => {
    const doc = docFrom(base);
    const changes = recordChanges(doc);
    accepted(applyTimelineEdit(doc, addVideo(fixtureClip(cid(5), V2, 200, 10), ON), ORIGIN));
    expect(changes).toEqual([`clips:${cid(5)}`]);
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

  it('undoes an addition by removing the clip and keeping its new source', () => {
    const doc = docFrom(base);
    const undo = undoManager(doc, ORIGIN);
    accepted(applyTimelineEdit(doc, addVideo(fixtureClip(cid(5), V2, 200, 10, { sourceId: SHORT_SOURCE.id }), ON, SHORT_SOURCE), ORIGIN));
    undo.undo();
    const after = readTimelineDocument(doc);
    expect(after.clips).toEqual(base.clips);
    expect(after.sources).toEqual({ [SOURCE.id]: SOURCE, [SHORT_SOURCE.id]: SHORT_SOURCE });
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
    return resolveTimelineArrangement({ tracks: Object.values(value.tracks), clips: Object.values(value.clips), sources: value.sources, fps: value.settings.fps });
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
      expect(resolveTimelineArrangement({ tracks: Object.values(value.tracks), clips: Object.values(value.clips) }).readyClipIds).toEqual([K]);
    }
    const bytes = Y.encodeStateAsUpdate(left);
    expect(applyTimelineEdit(left, setRange(K, 0, 24, 60, ON), ORIGIN)).toEqual({ ok: false, reason: 'invalid_range' });
    expect(applyTimelineEdit(left, setRange(K, 0, 20, 48, ON), ORIGIN)).toEqual({ ok: false, reason: 'invalid_range' });
    expect(Y.encodeStateAsUpdate(left)).toEqual(bytes);
    accepted(applyTimelineEdit(left, setRange(K, 0, 0, 48, ON), ORIGIN));
    expect(arrange(left).hasConflicts).toBe(false);
  });
});

describe('Timeline content with damaged records (inner#1708 F1b)', () => {
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

  it('reads every valid record and lists the damaged ones', () => {
    const doc = damagedDoc();
    const content = readTimelineContent(doc);
    expect(content.document.clips).toEqual({ [clip.id]: clip });
    expect(content.document.tracks).toEqual({ 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 } });
    expect(content.document.sources).toEqual({ [source.id]: source });
    expect(content.damaged).toEqual({ clips: [BAD_CLIP], tracks: [BAD_TRACK] });
  });

  it('reads the same valid document through readTimelineDocument without throwing', () => {
    const doc = damagedDoc();
    expect(() => readTimelineDocument(doc)).not.toThrow();
    expect(readTimelineDocument(doc)).toEqual(readTimelineContent(doc).document);
  });

  it('reports nothing damaged for intact content', () => {
    const doc = seededDoc();
    expect(applyTimelineEdit(doc, add, ORIGIN).ok).toBe(true);
    expect(readTimelineContent(doc)).toEqual({ document: readTimelineDocument(doc), damaged: { clips: [], tracks: [] } });
  });

  it('still refuses missing and unsupported Timeline roots', () => {
    expect(typeof readTimelineContent).toBe('function');
    expect(() => readTimelineContent(trackedDoc())).toThrow(Error);
    const unsupported = seededDoc();
    unsupported.getMap('timeline').set('schemaVersion', 2);
    expect(() => readTimelineContent(unsupported)).toThrow(Error);
  });

  it('removes one damaged record in one transaction with the given origin', () => {
    const doc = damagedDoc();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => { origins.push(transaction.origin); });
    removeTimelineRecord(doc, 'clips', BAD_CLIP, ORIGIN);
    expect(origins).toEqual([ORIGIN]);
    expect(doc.getMap('clips').has(BAD_CLIP)).toBe(false);
    expect(doc.getMap('clips').has(clip.id)).toBe(true);
    removeTimelineRecord(doc, 'tracks', BAD_TRACK, OTHER_ORIGIN);
    expect(origins).toEqual([ORIGIN, OTHER_ORIGIN]);
    expect(readTimelineContent(doc).damaged).toEqual({ clips: [], tracks: [] });
  });

  it('reads through the shared space-content entry that integration tests use, and edits only in web', () => {
    expect(typeof spaceContent.readTimelineContent).toBe('function');
    expect(typeof spaceContent.readTimelineDocument).toBe('function');
    expect(readTimelineContent).toBe(spaceContent.readTimelineContent);
    expect(readTimelineDocument).toBe(spaceContent.readTimelineDocument);
    expect(sharedIndex).not.toHaveProperty('planTimelineEdit');
  });
});
