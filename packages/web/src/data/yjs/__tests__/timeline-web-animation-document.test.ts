// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Writing web-animation copies and landing receipts into the shared Timeline (inner#1711 design §3.3, §9).
 *
 * `applyTimelineEdit` writes `operationReceipts[actionId]` in the same transaction as the copy, so collab accepts one
 * stored state that holds both; it compares receipts as well as tracks and clips before deciding an edit changes
 * nothing. The receipts root is outside the personal UndoManager: undoing `land_execution` removes only the copy this
 * user wrote, because collab has already admitted the execution on the receipt.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { FPS, MAIN, OFF, cid, clip, seededDoc, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import {
  EXEC_RUNNING, RESOLUTION, SRC_A, addResult, boundTo, land, waitingFor, webClip,
} from '@web/data/yjs/__tests__/timeline-web-fixtures';

const ACTION = 'a0000000-0000-4000-8000-000000000001';
const RECEIPT = { executionId: EXEC_RUNNING, inputHash: 'sha256:abc', landedAt: '2026-11-07T08:00:00.000Z' };
const PLACEHOLDER = { clipId: cid(1), startFrame: 24, newTrackId: 'track-new', extent: { acceptedDurationFrames: 72, fps: FPS } };
const NAME = 'project-p/timeline-web';
const docs: Y.Doc[] = [];

/**
 * A seeded document, tracked for cleanup.
 * @param clips - Its clips.
 * @returns The document.
 * @throws {Error} When the fixture is invalid.
 */
function seeded(clips: Parameters<typeof timeline>[0] = []): Y.Doc {
  const doc = seededDoc(timeline(clips));
  docs.push(doc);
  return doc;
}

/**
 * Count the updates a write emits.
 * @param doc - The document.
 * @param write - The write.
 * @returns The updates, in order.
 * @throws {never} Never.
 */
function updatesOf(doc: Y.Doc, write: () => void): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const listener = (update: Uint8Array): void => { updates.push(update); };
  doc.on('update', listener);
  try {
    write();
  } finally {
    doc.off('update', listener);
  }
  return updates;
}

afterEach(() => {
  evictTimelineEditSession(NAME);
  for (const doc of docs.splice(0)) doc.destroy();
});

describe('applyTimelineEdit with receipts', () => {
  it('writes a receipt alone, which an edit comparing only tracks and clips would drop as a no-op', () => {
    const doc = seeded([clip(cid(9), MAIN, 0, 10)]);
    const result = applyTimelineEdit(doc, land(ACTION, RECEIPT, OFF), 'test', undefined, RESOLUTION);
    expect(result.ok).toBe(true);
    expect(readTimelineDocument(doc).operationReceipts).toEqual({ [ACTION]: RECEIPT });
    expect(doc.share.has('operationReceipts')).toBe(true);
  });

  it('writes the receipt and its placeholder copy in one update, so one stored state holds both', () => {
    const doc = seeded();
    const updates = updatesOf(doc, () => {
      expect(applyTimelineEdit(doc, land(ACTION, RECEIPT, OFF, PLACEHOLDER), 'test', undefined, RESOLUTION).ok).toBe(true);
    });
    expect(updates).toHaveLength(1);
    const read = readTimelineDocument(doc);
    expect(read.operationReceipts).toEqual({ [ACTION]: RECEIPT });
    expect(read.clips[cid(1)]).toMatchObject({ kind: 'web-animation', contentBinding: waitingFor(EXEC_RUNNING), startFrame: 24, durationFrames: 72 });
  });

  it('writes nothing when the same receipt has already landed', () => {
    const doc = seeded();
    applyTimelineEdit(doc, land(ACTION, RECEIPT, OFF), 'test', undefined, RESOLUTION);
    const updates = updatesOf(doc, () => {
      expect(applyTimelineEdit(doc, land(ACTION, RECEIPT, OFF), 'test', undefined, RESOLUTION).ok).toBe(true);
    });
    expect(updates).toEqual([]);
  });

  it('adds a result as a copy whose content stays out of the document sources', () => {
    const doc = seeded();
    expect(applyTimelineEdit(doc, addResult(cid(2), SRC_A, 0, 'track-new', OFF), 'test', undefined, RESOLUTION).ok).toBe(true);
    const read = readTimelineDocument(doc);
    expect(read.clips[cid(2)]).toMatchObject({ kind: 'web-animation', contentBinding: boundTo(SRC_A) });
    expect(read.sources).toEqual({});
  });

  it('keeps a video source when a web copy is deleted beside it, and writes no source for the copy', () => {
    const doc = seeded([clip(cid(9), MAIN, 0, 10), webClip(cid(3), 'v2', 0, 24)]);
    expect(applyTimelineEdit(doc, { operation: 'delete', parameters: { clipId: cid(3) }, placement: OFF }, 'test', undefined, RESOLUTION).ok).toBe(true);
    expect(Object.keys(readTimelineDocument(doc).sources)).toHaveLength(1);
  });
});

describe('personal undo of land_execution', () => {
  it('removes the copy it added and keeps the receipt', () => {
    const doc = seeded();
    const session = getTimelineEditSession(doc, NAME);
    session.setCanWrite(true);
    expect(session.edit(land(ACTION, RECEIPT, OFF, PLACEHOLDER)).ok).toBe(true);
    expect(session.getSnapshot().canUndo).toBe(true);
    session.undo();
    const read = readTimelineDocument(doc);
    expect(read.clips[cid(1)]).toBeUndefined();
    expect(read.operationReceipts).toEqual({ [ACTION]: RECEIPT });
  });

  it('makes no undo step for a receipt landed without a copy', () => {
    const doc = seeded();
    const session = getTimelineEditSession(doc, NAME);
    session.setCanWrite(true);
    expect(session.edit(land(ACTION, RECEIPT, OFF)).ok).toBe(true);
    expect(session.getSnapshot().canUndo).toBe(false);
    expect(readTimelineDocument(doc).operationReceipts).toEqual({ [ACTION]: RECEIPT });
  });

  it('undoes each addition of the same result on its own, leaving the other copies', () => {
    const doc = seeded();
    const session = getTimelineEditSession(doc, NAME);
    session.setCanWrite(true);
    expect(session.edit(addResult(cid(1), SRC_A, 0, 'track-a', OFF)).ok).toBe(true);
    expect(session.edit(addResult(cid(2), SRC_A, 0, 'track-b', OFF)).ok).toBe(true);
    session.undo();
    const read = readTimelineDocument(doc);
    expect(read.clips[cid(2)]).toBeUndefined();
    expect(read.clips[cid(1)]).toMatchObject({ contentBinding: boundTo(SRC_A) });
  });
});
