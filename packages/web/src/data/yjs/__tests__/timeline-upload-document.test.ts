// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Undo around an upload placeholder turning into a clip (#1434 design §2.2, inner#1709 design §2.4, §4.3).
 *
 * Collab turns a registered upload's placeholders into video, picture or sound clips with the shared
 * `applyTimelineUpload(doc, event)`, in one transaction under `TIMELINE_UPLOAD_ORIGIN`, which no undo manager tracks;
 * its rules are tested in shared. The page no longer converts (`convertTimelineUpload` is gone).
 *
 * The conversion changes a clip's kind outside any session, so an undo or redo of a step from before it must not
 * write the placeholder's `upload` back into the clip: `repairAfterPop` fills every missing field only when the
 * current record has no `kind` or the same kind as the step's snapshot, and otherwise only the placement fields. A
 * placeholder revived after its upload finished stays a placeholder: no event comes for it again.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TimelineClipSchema, type TimelineVideoSource,
} from '@breatic/shared';
import { applyTimelineUpload, readTimelineContent } from '@breatic/shared/space-content';

import { _resetForTests } from '@web/data/yjs/manager';
import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession, type TimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import type { TimelineEditCommand } from '@web/data/yjs/timeline-edit';
import {
  MAIN, OFF, SOURCE, V2, V3, cid, clip, seededDoc, timeline, track,
} from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { RESOLUTION, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';
import {
  UPLOAD_ID, addUpload, clipRecords, completedUpload, uploadClip,
} from '@web/data/yjs/__tests__/timeline-upload-fixtures';
import { mediaUpload } from '@web/data/yjs/__tests__/timeline-media-fixtures';

const docs: Y.Doc[] = [];
const names = new Set<string>();
const TRACKS = [track(MAIN, 0), track(V2, 1), track(V3, 2)];
/** 5 s registered: 120 frames, longer than the 60 the browser read. */
const LONGER = completedUpload(5);

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

const move = (clipId: string, startFrame: number): TimelineEditCommand => ({ operation: 'move', parameters: { clipId, startFrame }, placement: OFF });

afterEach(() => {
  for (const name of names) evictTimelineEditSession(name);
  names.clear();
  for (const doc of docs.splice(0)) doc.destroy();
  _resetForTests();
});

describe('undo and redo around a conversion (design §2.2)', () => {
  it('undoes a move made before the conversion as a move only, keeping the clip a video', () => {
    const doc = docWith([]);
    const session = sessionOf(doc);
    expect(session.edit(addUpload(uploadClip(cid(1), V2, 0), OFF)).ok).toBe(true);
    expect(session.edit(move(cid(1), 40)).ok).toBe(true);
    applyTimelineUpload(doc, LONGER);
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
    applyTimelineUpload(doc, LONGER);
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
    applyTimelineUpload(doc, LONGER);
    session.undo();
    expect(doc.getMap('clips').has(cid(1))).toBe(false);
    session.redo();
    expect(doc.getMap('clips').has(cid(1))).toBe(true);
    expectAllValid(doc);
  });

  it.each([['image', null], ['audio', 5]] as const)('undoes a move made before a %s placeholder turned into a clip as a move only (inner#1709 design §2.4)', (kind, seconds) => {
    const doc = docWith([]);
    const session = sessionOf(doc);
    const placeholder = mediaUpload(cid(1), V2, 0, 48, kind);
    expect(session.edit(addUpload(placeholder as unknown as Parameters<typeof addUpload>[0], OFF)).ok).toBe(true);
    expect(session.edit(move(cid(1), 40)).ok).toBe(true);
    applyTimelineUpload(doc, completedUpload(seconds, kind, placeholder.upload.uploadId));
    session.undo();
    expectAllValid(doc);
    expect(clipRecords(doc)[cid(1)]).not.toHaveProperty('upload');
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind, startFrame: 0, sourceInFrame: 0 });
    session.redo();
    expectAllValid(doc);
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind, startFrame: 40 });
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
    applyTimelineUpload(mine, LONGER);
    expect(peerSession.edit({ operation: 'delete', parameters: { clipId: cid(1) }, placement: OFF }).ok).toBe(true);
    sync();
    peerSession.undo();
    sync();
    // No event comes again for the finished upload (inner#1709 design §7.1): the revived record stays a placeholder.
    for (const doc of [mine, peer]) {
      expectAllValid(doc);
      expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'upload', trackId: V2, startFrame: 0 });
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
