// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Writing mixed-media edits into the Timeline document (inner#1709 design §2.1, §2.4, §3.2, §3.5).
 *
 * `applyTimelineEdit` writes only what the plan changed: a new picture or sound clip re-sets its source like a video
 * (`reconcileTimelineSources` takes every created clip with a `sourceId`), `set_text` and `set_audio` set only their
 * fields, and a clip longer than its source that the edit did not touch is not written and gets no undo step. A
 * still picture, a text or a picture placeholder keeps its in-point at 0 through splits and overwrites, so every record
 * stays readable. A document that an older page wrote into (tracks with a `kind`, placeholders without
 * `upload.kind`) is brought to version 3 in an untracked transaction before the edit.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readTimelineContent } from '@breatic/shared/space-content';

import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import { MAIN, OFF, ON, SHORT_SOURCE, SOURCE, V2, V3, cid, clip, seededDoc, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  AUDIO, IMAGE, addMedia, audioClip, imageClip, mediaUpload, mixedTimeline, setAudio, setText, textClip, type MediaClip, type MediaSource,
} from '@web/data/yjs/__tests__/timeline-media-fixtures';
import { uploadClip } from '@web/data/yjs/__tests__/timeline-upload-fixtures';

const ORIGIN = Symbol('timeline-media-session');
const PEER = Symbol('timeline-media-peer');
const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2)];
const MISSING = '10000000-0000-4000-8000-0000000000ff';
const docs: Y.Doc[] = [];

/**
 * A replica holding these clips, cleaned up after the test.
 * @param clips - The clips.
 * @param sources - The sources.
 * @returns The replica.
 * @throws {Error} When seeding fails.
 */
function docWith(clips: readonly MediaClip[], sources: readonly MediaSource[] = [SOURCE, SHORT_SOURCE, IMAGE, AUDIO]): Y.Doc {
  const doc = seededDoc(mixedTimeline(clips, TRACKS, sources));
  docs.push(doc);
  return doc;
}

/**
 * Record the `path:key` each transaction changes in clips, tracks, sources and the timeline map.
 * @param doc - The document.
 * @returns The live list.
 * @throws {never} Never.
 */
function recordChanges(doc: Y.Doc): string[] {
  const changes: string[] = [];
  for (const name of ['clips', 'tracks', 'sources', 'timeline']) {
    doc.getMap(name).observeDeep((events) => {
      for (const event of events) for (const key of (event as Y.YMapEvent<unknown>).keysChanged) changes.push(`${[name, ...event.path].join('/')}:${key}`);
    });
  }
  return changes;
}

/**
 * The undo manager the edit session holds.
 * @param doc - The document.
 * @returns The undo manager.
 * @throws {never} Never.
 */
function undoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([doc.getMap('tracks'), doc.getMap('clips'), doc.getMap('sources'), doc.getMap('timeline')], { trackedOrigins: new Set([ORIGIN]), captureTimeout: 0 });
}

/**
 * A stored clip record as JSON.
 * @param doc - The document.
 * @param id - The clip.
 * @returns The record.
 * @throws {never} Never.
 */
function record(doc: Y.Doc, id: string): unknown {
  const value = doc.getMap('clips').get(id);
  return value instanceof Y.Map ? value.toJSON() : value;
}

const move = (clipId: string, startFrame: number, target: { trackId?: string } = {}): TimelineEditCommand =>
  ({ operation: 'move', parameters: { clipId, startFrame, ...target }, placement: OFF });

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

describe('adding pictures and sounds (design §3.2)', () => {
  it.each([['picture', IMAGE, imageClip(cid(1), V2, 0, 120)], ['sound', AUDIO, audioClip(cid(1), V3, 0, 120)]] as const)(
    'writes a %s clip and its source in one transaction under the edit origin',
    (_name, source, added) => {
      const doc = docWith([], [SOURCE]);
      const origins: unknown[] = [];
      doc.on('afterTransaction', (transaction: Y.Transaction) => { if (transaction.origin === ORIGIN) origins.push(transaction.origin); });
      expect(applyTimelineEdit(doc, addMedia(source, added, OFF), ORIGIN).ok).toBe(true);
      expect(origins).toEqual([ORIGIN]);
      const read = readTimelineDocument(doc);
      expect(read.clips[cid(1)]).toEqual(added);
      expect(read.sources[source.id]).toEqual(source);
    },
  );

  it('re-sets a picture\'s source for every clip an edit creates from it, so a peer\'s concurrent sweep cannot leave it without one', () => {
    const start = docWith([imageClip(cid(1), V2, 0, 120)], [SOURCE, IMAGE]);
    const bytes = Y.encodeStateAsUpdate(start);
    const mine = new Y.Doc();
    const peer = new Y.Doc();
    docs.push(mine, peer);
    Y.applyUpdate(mine, bytes);
    Y.applyUpdate(peer, bytes);
    const changes = recordChanges(mine);
    expect(applyTimelineEdit(mine, { operation: 'duplicate', parameters: { clipId: cid(1), newClipId: cid(2) }, placement: OFF }, ORIGIN).ok).toBe(true);
    expect(changes).toContain(`sources:${IMAGE.id}`);
    expect(applyTimelineEdit(peer, { operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF }, PEER).ok).toBe(true);
    expect(peer.getMap('sources').has(IMAGE.id)).toBe(false);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(mine));
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer));
    for (const doc of [mine, peer]) expect(readTimelineDocument(doc).sources[IMAGE.id]).toEqual(IMAGE);
  });
});

describe('set_text and set_audio write only their fields (design §3.2)', () => {
  it('sets only the text of a text clip', () => {
    const doc = docWith([textClip(cid(1), V2, 0, 120)], []);
    const changes = recordChanges(doc);
    expect(applyTimelineEdit(doc, setText(cid(1), { body: 'Line one\nLine two', size: 0.12 }, ON), ORIGIN).ok).toBe(true);
    expect(changes).toEqual([`clips/${cid(1)}:text`]);
    expect(record(doc, cid(1))).toEqual(textClip(cid(1), V2, 0, 120, { text: { body: 'Line one\nLine two', size: 0.12 } }));
  });

  it('sets only the gain and mute of a sound clip, as one undo step', () => {
    const doc = docWith([audioClip(cid(1), V2, 0, 120)], [AUDIO]);
    const undo = undoManager(doc);
    const changes = recordChanges(doc);
    expect(applyTimelineEdit(doc, setAudio(cid(1), 2, true, ON), ORIGIN).ok).toBe(true);
    expect(changes.sort()).toEqual([`clips/${cid(1)}:gain`, `clips/${cid(1)}:mute`]);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(record(doc, cid(1))).toEqual(audioClip(cid(1), V2, 0, 120));
  });
});

describe('a clip longer than its source is written only when an edit touches it (design §3.5)', () => {
  const LONG = cid(1);
  const OTHER = cid(2);
  const long = clip(LONG, V2, 0, 100, { sourceId: SHORT_SOURCE.id });

  it.each([
    ['a transform of another clip', { operation: 'set_transform', parameters: { clipId: OTHER, transform: { frameX: 0.1, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 } }, placement: ON }],
    ['a frame change', { operation: 'set_frame', parameters: { preset: '9:16' }, placement: ON }],
    ['a move of another clip', { operation: 'move', parameters: { clipId: OTHER, startFrame: 300 }, placement: OFF }],
  ] as const)('does not write it for %s, so undo holds nothing of it', (_name, command) => {
    const doc = docWith([long, clip(OTHER, MAIN, 0, 48)]);
    const undo = undoManager(doc);
    const changes = recordChanges(doc);
    expect(applyTimelineEdit(doc, command as unknown as TimelineEditCommand, ORIGIN).ok).toBe(true);
    expect(changes.filter((change) => change.includes(LONG))).toEqual([]);
    expect(record(doc, LONG)).toEqual(long);
    undo.undo();
    expect(record(doc, LONG)).toEqual(long);
  });

  it('writes the length it plays once the edit touches it', () => {
    const doc = docWith([long]);
    expect(applyTimelineEdit(doc, move(LONG, 10), ORIGIN).ok).toBe(true);
    expect(record(doc, LONG)).toMatchObject({ startFrame: 10, durationFrames: 48 });
  });
});

describe('an overwrite reaching a clip that cannot be shown (design §3.5)', () => {
  it('writes the shortened length when its tail is covered', () => {
    const doc = docWith([clip(cid(1), V2, 0, 100, { sourceId: MISSING }), clip(cid(2), V2, 200, 20)]);
    expect(applyTimelineEdit(doc, move(cid(2), 90), ORIGIN).ok).toBe(true);
    expect(record(doc, cid(1))).toMatchObject({ startFrame: 0, durationFrames: 90, sourceInFrame: 0 });
  });

  it('deletes it when its head is covered, and brings it back on undo', () => {
    const doc = docWith([clip(cid(1), V2, 0, 100, { sourceId: MISSING }), clip(cid(2), V2, 200, 20)]);
    const undo = undoManager(doc);
    expect(applyTimelineEdit(doc, move(cid(2), 0), ORIGIN).ok).toBe(true);
    expect(doc.getMap('clips').has(cid(1))).toBe(false);
    undo.undo();
    expect(record(doc, cid(1))).toMatchObject({ startFrame: 0, durationFrames: 100, sourceId: MISSING });
  });
});

describe('still media keep in-point 0 and stay readable (design §3.3, §3.5)', () => {
  it.each([
    ['a picture', imageClip(cid(1), V2, 0, 120)],
    ['a text', textClip(cid(1), V2, 0, 120)],
    ['a picture placeholder', mediaUpload(cid(1), V2, 0, 120, 'image')],
  ] as const)('splits %s and covers its head and middle, every piece at in-point 0 and read back undamaged', (_name, still) => {
    const doc = docWith([still, clip(cid(2), V3, 0, 10)]);
    expect(applyTimelineEdit(doc, { operation: 'split', parameters: { clipId: cid(1), frame: 60, newClipId: cid(3) }, placement: OFF }, ORIGIN).ok).toBe(true);
    expect(applyTimelineEdit(doc, move(cid(2), 0, { trackId: V2 }), ORIGIN).ok).toBe(true);
    expect(applyTimelineEdit(doc, { operation: 'duplicate', parameters: { clipId: cid(2), newClipId: cid(4) }, placement: OFF }, ORIGIN).ok).toBe(true);
    const content = readTimelineContent(doc);
    expect(content.damaged.clips).toEqual([]);
    for (const id of [cid(1), cid(3)]) expect(content.document.clips[id]?.sourceInFrame, id).toBe(0);
    expect(content.document.clips[cid(1)]).toMatchObject({ startFrame: 20, durationFrames: 40 });
  });
});

describe('a document an older page wrote into (design §2.1)', () => {
  it('drops track kinds, names the placeholder\'s kind and marks version 3 in an untracked step before the edit', () => {
    const doc = docWith([clip(cid(1), MAIN, 0, 48), uploadClip(cid(2), V2, 0)]);
    doc.transact(() => {
      (doc.getMap('tracks').get(V2) as Y.Map<unknown>).set('kind', 'visual');
      const upload = { ...((doc.getMap('clips').get(cid(2)) as Y.Map<unknown>).get('upload') as Record<string, unknown>) };
      delete upload.kind;
      (doc.getMap('clips').get(cid(2)) as Y.Map<unknown>).set('upload', upload);
      doc.getMap('timeline').set('schemaVersion', 2);
    }, 'older-page');
    const undo = undoManager(doc);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => { origins.push(transaction.origin); });
    expect(applyTimelineEdit(doc, move(cid(1), 0, { trackId: V3 }), ORIGIN).ok).toBe(true);
    expect(origins).toHaveLength(2);
    expect(origins[1]).toBe(ORIGIN);
    expect((doc.getMap('tracks').get(V2) as Y.Map<unknown>).toJSON()).toEqual({ id: V2, order: 1 });
    expect(record(doc, cid(2))).toMatchObject({ upload: { kind: 'video' } });
    expect(doc.getMap('timeline').get('schemaVersion')).toBe(3);
    undo.undo();
    expect(record(doc, cid(1))).toMatchObject({ trackId: MAIN });
    expect(doc.getMap('timeline').get('schemaVersion')).toBe(3);
    expect((doc.getMap('tracks').get(V2) as Y.Map<unknown>).toJSON()).toEqual({ id: V2, order: 1 });
  });
});
