// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Turning upload placeholders into video clips, and undo around that conversion (#1434 design §2.2, §3.1, §3.3).
 *
 * `convertTimelineUpload(doc, uploadId, asset)` (in `timeline-document.ts`, beside `applyTimelineEdit`) is the write
 * the upload controller makes once an upload registered and this page may write. In one transaction under
 * `TIMELINE_UPLOAD_ORIGIN`, which no undo manager tracks, it writes one video source for the asset (the registered
 * duration, or `upload.durationSeconds` when the server has none) and turns every `upload` clip of that upload into a
 * video clip of it: `kind: 'video'`, `sourceId`, no `upload`. An untrimmed placeholder (in-point 0, the whole local
 * length) takes the asset's whole length, but never past the start of the next clip on its track; any other piece is
 * cut to what the asset holds with `timelineSourceRoom`, and a piece left with nothing is deleted. Its track and start
 * never change.
 *
 * The conversion changes a clip's kind outside any session, so an undo or redo of a step from before it must not
 * write the placeholder's `upload` back into the video clip: `repairAfterPop` fills every missing field only when the
 * current record has no `kind` or the same kind as the step's snapshot, and otherwise only the placement fields.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TimelineClipSchema, TimelineVideoClipSchema, TimelineVideoSourceSchema, type TimelineVideoSource,
} from '@breatic/shared';
import { readTimelineContent } from '@breatic/shared/space-content';

import { _resetForTests } from '@web/data/yjs/manager';
import {
  TIMELINE_UPLOAD_ORIGIN, applyTimelineEdit, convertTimelineUpload, readTimelineDocument,
} from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import {
  FPS, MAIN, OFF, SOURCE, V2, V3, cid, clip, connect, seededDoc, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { RESOLUTION, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';
import {
  ASSET_ID, OTHER_UPLOAD_ID, UPLOAD_FRAMES, UPLOAD_ID, addUpload, clipRecords, registeredVideo, uploadClip,
} from '@web/data/yjs/__tests__/timeline-upload-fixtures';

const docs: Y.Doc[] = [];
const names = new Set<string>();
const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2)];
/** 5 s registered: 120 frames, longer than the 60 the browser read. */
const LONGER = registeredVideo(5);
/** 1.5 s registered: 36 frames, shorter than the 60 the browser read. */
const SHORTER = registeredVideo(1.5);

/**
 * A replica holding these clips, cleaned up after the test.
 * @param clips - The clips.
 * @param sources - The sources.
 * @returns The replica.
 * @throws {Error} When the fixture is invalid.
 */
function docWith(clips: Parameters<typeof timeline>[0], sources: TimelineVideoSource[] = [SOURCE]): Y.Doc {
  const doc = seededDoc(timeline(clips, TRACKS, sources));
  docs.push(doc);
  return doc;
}

/**
 * The session for a replica, evicted after the test.
 * @param doc - The replica.
 * @param name - Its document name.
 * @returns The session.
 * @throws {never} Never.
 */
function sessionOf(doc: Y.Doc, name = 'project-p/timeline-upload'): TimelineEditSession {
  names.add(name);
  return getTimelineEditSession(doc, name);
}

/**
 * Assert every clip record of a replica reads as a valid clip and none is damaged.
 * @param doc - The replica.
 * @throws {Error} When a record is invalid.
 */
function expectAllValid(doc: Y.Doc): void {
  for (const [id, record] of Object.entries(clipRecords(doc))) {
    expect(TimelineClipSchema.safeParse(record).success, `clip ${id} is invalid: ${JSON.stringify(record)}`).toBe(true);
  }
  expect(readTimelineContent(doc).damaged.clips).toEqual([]);
}

/**
 * The source a converted clip names.
 * @param doc - The replica.
 * @param clipId - The clip.
 * @returns Its source.
 * @throws {Error} When the clip is not a video or its source is missing.
 */
function sourceOf(doc: Y.Doc, clipId: string): TimelineVideoSource {
  const read = readTimelineDocument(doc);
  const item = read.clips[clipId];
  if (item?.kind !== 'video') throw new Error(`Expected clip ${clipId} to be a video, got ${JSON.stringify(item)}`);
  const source = read.sources[item.sourceId];
  if (source === undefined) throw new Error(`Clip ${clipId} names a missing source`);
  return source;
}

const move = (clipId: string, startFrame: number): TimelineEditCommand => ({ operation: 'move', parameters: { clipId, startFrame }, placement: OFF });

afterEach(() => {
  for (const name of names) evictTimelineEditSession(name);
  names.clear();
  for (const doc of docs.splice(0)) doc.destroy();
  _resetForTests();
});

describe('convertTimelineUpload', () => {
  it('turns an untrimmed placeholder into a video of the whole longer registered asset, at the same track and start', () => {
    const doc = docWith([uploadClip(cid(1), V2, 10)]);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    const record = clipRecords(doc)[cid(1)] as Record<string, unknown>;
    expect(TimelineVideoClipSchema.safeParse(record).success, JSON.stringify(record)).toBe(true);
    expect(record).not.toHaveProperty('upload');
    expect(record).toMatchObject({ kind: 'video', trackId: V2, startFrame: 10, sourceInFrame: 0, durationFrames: 120 });
    expect(sourceOf(doc, cid(1))).toMatchObject({ kind: 'video', assetId: ASSET_ID, timebase: FPS, extentFrames: 120, durationSeconds: '5', durationOrigin: 'registered' });
    expect(TimelineVideoSourceSchema.safeParse(sourceOf(doc, cid(1))).success).toBe(true);
  });

  it('extends an untrimmed placeholder only up to the next clip on its track', () => {
    const doc = docWith([uploadClip(cid(1), V2, 10), clip(cid(2), V2, 100, 20), clip(cid(3), V3, 50, 10)]);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 10, durationFrames: 90 });
    expect(readTimelineDocument(doc).clips[cid(2)]).toMatchObject({ startFrame: 100, durationFrames: 20 });
  });

  it('shortens an untrimmed placeholder to a shorter registered asset', () => {
    const doc = docWith([uploadClip(cid(1), MAIN, 0)]);
    convertTimelineUpload(doc, UPLOAD_ID, SHORTER);
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', durationFrames: 36 });
    expect(sourceOf(doc, cid(1))).toMatchObject({ extentFrames: 36, durationSeconds: '1.5' });
  });

  it('cuts trimmed pieces to the asset, deletes a piece left empty and gives the rest one source', () => {
    const doc = docWith([
      uploadClip(cid(1), V2, 0, 20),
      uploadClip(cid(2), V2, 20, 25, { sourceInFrame: 20 }),
      uploadClip(cid(3), V2, 45, 15, { sourceInFrame: 40 }),
    ]);
    convertTimelineUpload(doc, UPLOAD_ID, SHORTER);
    const read = readTimelineDocument(doc);
    expect(read.clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 0, sourceInFrame: 0, durationFrames: 20 });
    expect(read.clips[cid(2)]).toMatchObject({ kind: 'video', startFrame: 20, sourceInFrame: 20, durationFrames: 16 });
    expect(read.clips[cid(3)]).toBeUndefined();
    expect(doc.getMap('clips').has(cid(3))).toBe(false);
    expect(sourceOf(doc, cid(1)).id).toBe(sourceOf(doc, cid(2)).id);
  });

  it('keeps a trimmed piece whole when the longer asset holds it', () => {
    const doc = docWith([uploadClip(cid(1), V2, 5, 30, { sourceInFrame: 20 })]);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 5, sourceInFrame: 20, durationFrames: 30 });
  });

  it('measures the source by the local duration when the server registered none', () => {
    const doc = docWith([uploadClip(cid(1), V2, 0)]);
    convertTimelineUpload(doc, UPLOAD_ID, registeredVideo(null));
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', durationFrames: UPLOAD_FRAMES });
    expect(sourceOf(doc, cid(1))).toMatchObject({ assetId: ASSET_ID, extentFrames: UPLOAD_FRAMES, durationSeconds: '2.5' });
  });

  it('leaves the placeholders of another upload alone', () => {
    const other = uploadClip(cid(2), V3, 0, 30, { upload: { uploadId: OTHER_UPLOAD_ID, name: 'other.mov', durationSeconds: 3 } });
    const doc = docWith([uploadClip(cid(1), V2, 0), other]);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    expect(readTimelineDocument(doc).clips[cid(2)]).toEqual(other);
  });

  it('writes in one transaction under the untracked upload origin, adding no undo step', () => {
    const doc = docWith([uploadClip(cid(1), V2, 0), uploadClip(cid(2), V3, 0, 20)]);
    const session = sessionOf(doc);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction: Y.Transaction) => { if (transaction.changed.size > 0) origins.push(transaction.origin); });
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    expect(origins.filter((origin) => origin === TIMELINE_UPLOAD_ORIGIN)).toHaveLength(1);
    expect(origins.every((origin) => origin !== session.origin)).toBe(true);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('writes nothing when no placeholder of the upload is in the document', () => {
    const doc = docWith([clip(cid(1), MAIN, 0, 10)]);
    const before = Y.encodeStateVector(doc);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });

  it('converts a placeholder a peer stored as a plain value', () => {
    const doc = docWith([]);
    doc.getMap('clips').set(cid(1), uploadClip(cid(1), V2, 0));
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    expect(doc.getMap('clips').get(cid(1))).toBeInstanceOf(Y.Map);
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', durationFrames: 120 });
    expectAllValid(doc);
  });

  it('converts the copy a peer receives as well', () => {
    const doc = docWith([uploadClip(cid(1), V2, 0)]);
    const peer = new Y.Doc();
    docs.push(peer);
    connect(doc, peer);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    expect(readTimelineDocument(peer).clips[cid(1)]).toMatchObject({ kind: 'video', durationFrames: 120 });
    expectAllValid(peer);
  });
});

describe('undo and redo around a conversion (design §2.2)', () => {
  it('undoes a move made before the conversion as a move only, keeping the clip a video', () => {
    const doc = docWith([]);
    const session = sessionOf(doc);
    expect(session.edit(addUpload(uploadClip(cid(1), V2, 0), OFF)).ok).toBe(true);
    expect(session.edit(move(cid(1), 40)).ok).toBe(true);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    session.undo();
    expectAllValid(doc);
    expect(clipRecords(doc)[cid(1)]).not.toHaveProperty('upload');
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 0 });
    session.redo();
    expectAllValid(doc);
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 40 });
  });

  it('undoes a split made before the conversion without writing the placeholder fields back', () => {
    const doc = docWith([]);
    const session = sessionOf(doc);
    expect(session.edit(addUpload(uploadClip(cid(1), V2, 0), OFF)).ok).toBe(true);
    expect(session.edit({ operation: 'split', parameters: { clipId: cid(1), frame: 30, newClipId: cid(2) }, placement: OFF }).ok).toBe(true);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    session.undo();
    expectAllValid(doc);
    expect(doc.getMap('clips').has(cid(2))).toBe(false);
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 0 });
    session.redo();
    expectAllValid(doc);
  });

  it('removes the clip when the addition is undone after the conversion, and brings back a valid clip on redo', () => {
    const doc = docWith([]);
    const session = sessionOf(doc);
    expect(session.edit(addUpload(uploadClip(cid(1), V2, 0), OFF)).ok).toBe(true);
    convertTimelineUpload(doc, UPLOAD_ID, LONGER);
    session.undo();
    expect(doc.getMap('clips').has(cid(1))).toBe(false);
    session.redo();
    expect(doc.getMap('clips').has(cid(1))).toBe(true);
    expectAllValid(doc);
  });

  it('fills only placement fields when the kind changed outside the session, for any kind', () => {
    // A web copy turned into a video by an untracked writer: the undo of my move must not write `contentBinding` back.
    const doc = docWith([webClip(cid(1), V2, 0, 48)]);
    const session = sessionOf(doc);
    session.setWebResolution(RESOLUTION);
    expect(session.edit(move(cid(1), 20)).ok).toBe(true);
    doc.transact(() => {
      const record = doc.getMap('clips').get(cid(1)) as Y.Map<unknown>;
      record.set('kind', 'video');
      record.set('sourceId', SOURCE.id);
      record.delete('contentBinding');
      doc.getMap('sources').set(SOURCE.id, SOURCE);
    }, Symbol('untracked-conversion'));
    session.undo();
    expectAllValid(doc);
    expect(clipRecords(doc)[cid(1)]).not.toHaveProperty('contentBinding');
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'video', startFrame: 0, sourceId: SOURCE.id });
  });

  const CASES = [
    { seededByMe: true, mineFirst: true }, { seededByMe: true, mineFirst: false },
    { seededByMe: false, mineFirst: true }, { seededByMe: false, mineFirst: false },
  ];

  it.each(CASES)('fills every field of a placeholder revived without its kind (seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    // I delete the placeholder while a peer moves it; my undo revives a record holding only the peer's field.
    const seeded = docWith([clip(cid(9), MAIN, 0, 48), uploadClip(cid(1), V2, 0)]);
    const copy = new Y.Doc();
    docs.push(copy);
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(seeded));
    const mine = seededByMe ? seeded : copy;
    const peer = seededByMe ? copy : seeded;
    const session = sessionOf(mine);
    const sync = (): void => {
      if (mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(mine), 'remote');
      if (!mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
    };
    expect(session.edit({ operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF }).ok).toBe(true);
    expect(applyTimelineEdit(peer, move(cid(1), 100), Symbol('peer')).ok).toBe(true);
    sync();
    session.undo();
    sync();
    for (const doc of [mine, peer]) {
      expectAllValid(doc);
      expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'upload', upload: { uploadId: UPLOAD_ID } });
    }
  });

  it.each(CASES)('leaves valid records when a peer deletes a placeholder while I convert it, and the peer undoes the delete (seeded by me $seededByMe, I receive first $mineFirst)', ({ seededByMe, mineFirst }) => {
    const seeded = docWith([clip(cid(9), MAIN, 0, 48), uploadClip(cid(1), V2, 0)]);
    const copy = new Y.Doc();
    docs.push(copy);
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(seeded));
    const mine = seededByMe ? seeded : copy;
    const peer = seededByMe ? copy : seeded;
    const peerSession = sessionOf(peer, 'project-p/timeline-upload-peer');
    const sync = (): void => {
      if (mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(mine), 'remote');
      if (!mineFirst) Y.applyUpdate(mine, Y.encodeStateAsUpdate(peer), 'remote');
    };
    convertTimelineUpload(mine, UPLOAD_ID, LONGER);
    expect(peerSession.edit({ operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF }).ok).toBe(true);
    sync();
    peerSession.undo();
    sync();
    // My page converts any placeholder of a finished upload that reappears.
    convertTimelineUpload(mine, UPLOAD_ID, LONGER);
    sync();
    for (const doc of [mine, peer]) {
      expectAllValid(doc);
      const revived = readTimelineDocument(doc).clips[cid(1)];
      expect(revived).toMatchObject({ kind: 'video', trackId: V2, startFrame: 0 });
      if (revived?.kind === 'video') expect(readTimelineDocument(doc).sources[revived.sourceId]).toMatchObject({ assetId: ASSET_ID });
    }
  });
});

describe('a page that cannot read the clip kind (an older client, B7)', () => {
  it('lists the record as damaged, and its edits keep the record and every source a readable clip names', () => {
    // A kind this build does not know stands in for `upload` as an older build sees it: the same mechanism decides.
    const doc = docWith([clip(cid(9), MAIN, 0, 48)]);
    const unknown = { ...uploadClip(cid(1), V2, 0), kind: 'future-kind' };
    doc.transact(() => {
      const record = new Y.Map<unknown>();
      doc.getMap('clips').set(cid(1), record);
      for (const [key, value] of Object.entries(unknown)) record.set(key, value);
    });
    expect(readTimelineContent(doc).damaged.clips).toEqual([cid(1)]);
    expect(applyTimelineEdit(doc, move(cid(9), 10), Symbol('old-edit')).ok).toBe(true);
    expect(applyTimelineEdit(doc, { operation: 'duplicate', parameters: { clipId: cid(9), newClipId: cid(2) }, placement: OFF }, Symbol('old-edit')).ok).toBe(true);
    expect(clipRecords(doc)[cid(1)]).toEqual(unknown);
    expect(readTimelineDocument(doc).sources[SOURCE.id]).toEqual(SOURCE);
  });
});
