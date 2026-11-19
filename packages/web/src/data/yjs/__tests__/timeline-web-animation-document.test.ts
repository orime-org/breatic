// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writing web-animation copies into the shared Timeline (inner#1711 design §3.3, §9; #1490 design §8.2). A copy binds
 * to a succeeded result's source version; the `operationReceipts` root an older Timeline left stays as
 * it is.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { applyTimelineEdit, readTimelineDocument } from '@web/data/yjs/timeline-document';
import { evictTimelineEditSession, getTimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { MAIN, OFF, cid, clip, seededDoc, timeline } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { EXEC_RUNNING, RESOLUTION, SRC_A, addResult, boundTo, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

const ACTION = 'a0000000-0000-4000-8000-000000000001';
const RECEIPT = { executionId: EXEC_RUNNING, inputHash: 'sha256:abc', landedAt: '2026-11-07T08:00:00.000Z' };
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

describe('applyTimelineEdit with web-animation copies', () => {
  it('adds a copy in one update and leaves the receipts an older Timeline wrote', () => {
    const doc = seeded();
    doc.getMap<unknown>('operationReceipts').set(ACTION, RECEIPT);
    const updates = updatesOf(doc, () => {
      expect(applyTimelineEdit(doc, addResult(cid(1), SRC_A, 24, 'track-new', OFF), 'test', undefined, RESOLUTION).ok).toBe(true);
    });
    expect(updates).toHaveLength(1);
    expect(doc.getMap<unknown>('operationReceipts').toJSON()).toEqual({ [ACTION]: RECEIPT });
    expect(readTimelineDocument(doc).clips[cid(1)]).toMatchObject({ kind: 'web-animation', contentBinding: boundTo(SRC_A), startFrame: 24 });
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

describe('personal undo of web-animation copies', () => {
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
