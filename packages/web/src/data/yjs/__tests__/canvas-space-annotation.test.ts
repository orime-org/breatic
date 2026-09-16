// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Annotation replies survive concurrent posting (#1881).
 *
 * `replies` is born with the node for the reason `focusImages` is: two
 * clients replying to an annotation that has none yet would each create
 * their own container under the key, and the merge keeps one — the race
 * `buildDataMap` already records for `prompt` (#1880), observed rather
 * than reasoned about.
 *
 * The concurrency scenarios replay a true two-client divergence through the
 * public write API: capture a baseline, let A write on it, reset the
 * registry, rebuild B from the same baseline (a fresh Y.Doc, so a different
 * clientID), let B write, then merge both ways and assert both replicas
 * hold every reply.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type CanvasNodeFields } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  addReply,
  editAnnotationBody,
  editReply,
  getCanvasUndoManager,
  readNodes,
  removeNode,
  removeReply,
} from '@web/data/yjs/canvas-space';

const PID = 'p1';
const SID = 's1';
const NID = 'a1';

/**
 * The annotation the writes target.
 * @returns Wire fields for a sticky authored by `u-author`.
 */
const annotation = (): CanvasNodeFields => ({
  id: NID,
  type: 'annotation',
  position: { x: 0, y: 0 },
  data: {
    name: 'Note',
    locked: false,
    attachments: [],
    content: 'a cooler shot here',
    createdBy: 'u-author',
    createdAt: 1_757_000_000_000,
  },
});

/**
 * The annotation's data map on the live doc.
 * @returns The Y.Map under `nodesMap[NID].data`.
 */
const dataMap = (): Y.Map<unknown> => {
  const node = getDoc(docName.canvasSpace(PID, SID))
    .getMap<Y.Map<unknown>>(CANVAS_NODES_KEY)
    .get(NID);
  return node?.get('data') as Y.Map<unknown>;
};

/**
 * Reply bodies in document order.
 * @param doc - The document to read, defaulting to the live one.
 * @returns Each reply's `content`.
 */
const replyBodies = (doc?: Y.Doc): string[] => {
  const source = doc ?? getDoc(docName.canvasSpace(PID, SID));
  const node = source.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get(NID);
  const replies = (node?.get('data') as Y.Map<unknown>)?.get('replies');
  return replies instanceof Y.Array
    ? replies.toArray().map((r) => (r as Y.Map<unknown>).get('content') as string)
    : [];
};

describe('an annotation in the canvas document', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('is born holding a replies container, before anyone replies', () => {
    addNode(PID, SID, annotation());
    expect(dataMap().get('replies')).toBeInstanceOf(Y.Array);
    expect(replyBodies()).toEqual([]);
  });

  it('carries no prompt container, since a sticky generates nothing', () => {
    addNode(PID, SID, annotation());
    expect(dataMap().get('prompt')).toBeUndefined();
  });

  it('appends a reply with its author and time', () => {
    addNode(PID, SID, annotation());
    addReply(PID, SID, NID, {
      id: 'r1',
      content: 'agreed, slower',
      createdBy: 'u-other',
      createdAt: 1_757_000_100_000,
    });
    const replies = dataMap().get('replies') as Y.Array<Y.Map<unknown>>;
    expect(replies.length).toBe(1);
    expect(replies.get(0).get('createdBy')).toBe('u-other');
    expect(replies.get(0).get('createdAt')).toBe(1_757_000_100_000);
  });

  // Whether anything changed is settled by the box before these are called —
  // it is the only thing that saw what it opened with (`annotation-draft`).
  // What is pinned here is that a rewrite lands whole.
  it('stamps editedAt when the body is rewritten, and leaves birth alone', () => {
    addNode(PID, SID, annotation());
    editAnnotationBody(PID, SID, NID, 'a cooler, slower shot', 1_757_000_200_000);
    expect(dataMap().get('content')).toBe('a cooler, slower shot');
    expect(dataMap().get('editedAt')).toBe(1_757_000_200_000);
    expect(dataMap().get('createdAt')).toBe(1_757_000_000_000);
    expect(dataMap().get('createdBy')).toBe('u-author');
  });

  it('stamps editedAt on a reply the same way', () => {
    addNode(PID, SID, annotation());
    addReply(PID, SID, NID, {
      id: 'r1',
      content: 'agreed',
      createdBy: 'u-other',
      createdAt: 1_757_000_100_000,
    });
    editReply(PID, SID, NID, 'r1', 'agreed, slower', 1_757_000_300_000);
    const reply = (dataMap().get('replies') as Y.Array<Y.Map<unknown>>).get(0);
    expect(reply.get('content')).toBe('agreed, slower');
    expect(reply.get('editedAt')).toBe(1_757_000_300_000);
  });

  it('removes one reply by id and leaves the rest', () => {
    addNode(PID, SID, annotation());
    for (const id of ['r1', 'r2', 'r3']) {
      addReply(PID, SID, NID, {
        id,
        content: `reply ${id}`,
        createdBy: 'u-other',
        createdAt: 1_757_000_100_000,
      });
    }
    removeReply(PID, SID, NID, 'r2');
    expect(replyBodies()).toEqual(['reply r1', 'reply r3']);
  });

  it('ignores a reply aimed at a node that is gone', () => {
    addNode(PID, SID, annotation());
    expect(() =>
      addReply(PID, SID, 'no-such-node', {
        id: 'r1',
        content: 'into the void',
        createdBy: 'u-other',
        createdAt: 1_757_000_100_000,
      }),
    ).not.toThrow();
  });

  // Whoever asked for the write is holding the words the user just typed, and
  // a silent no-op leaves them with nowhere to say they went. The answer is
  // the only way the box up there can tell "written" from "written nowhere".
  it('answers whether the words landed', () => {
    addNode(PID, SID, annotation());
    const reply = {
      id: 'r1',
      content: 'agreed',
      createdBy: 'u-other',
      createdAt: 1_757_000_100_000,
    };
    expect(addReply(PID, SID, NID, reply)).toBe(true);
    expect(addReply(PID, SID, 'no-such-node', reply)).toBe(false);

    expect(editAnnotationBody(PID, SID, NID, 'reworded', 1_757_000_200_000)).toBe(
      true,
    );
    expect(
      editAnnotationBody(PID, SID, 'no-such-node', 'x', 1_757_000_200_000),
    ).toBe(false);

    expect(editReply(PID, SID, NID, 'r1', 'agreed, slower', 1_757_000_300_000)).toBe(
      true,
    );
    expect(
      editReply(PID, SID, NID, 'no-such-reply', 'x', 1_757_000_300_000),
    ).toBe(false);
  });

  it('keeps both replies when two clients answer an annotation that has none', () => {
    addNode(PID, SID, annotation());
    const name = docName.canvasSpace(PID, SID);
    const baseline = Y.encodeStateAsUpdate(getDoc(name));

    addReply(PID, SID, NID, {
      id: 'r-a',
      content: 'from A',
      createdBy: 'u-a',
      createdAt: 1_757_000_100_000,
    });
    const fromA = Y.encodeStateAsUpdate(getDoc(name));

    _resetForTests();
    Y.applyUpdate(getDoc(name), baseline);
    addReply(PID, SID, NID, {
      id: 'r-b',
      content: 'from B',
      createdBy: 'u-b',
      createdAt: 1_757_000_100_000,
    });
    const fromB = Y.encodeStateAsUpdate(getDoc(name));

    const ab = new Y.Doc();
    Y.applyUpdate(ab, fromA);
    Y.applyUpdate(ab, fromB);
    const ba = new Y.Doc();
    Y.applyUpdate(ba, fromB);
    Y.applyUpdate(ba, fromA);

    expect(replyBodies(ab).sort()).toEqual(['from A', 'from B']);
    expect(replyBodies(ba).sort()).toEqual(['from A', 'from B']);
  });
});


describe('undoing a rewrite (#1881 section 6.3)', () => {
  it('takes the body and its stamp back together, and forward together', () => {
    // Both writes are in one `doc.transact(..., CANVAS_UNDO)`, so the undo
    // manager holds them as one item. Split across two transactions they
    // would be two steps, and the step between them says a note was edited
    // while showing what it said before the edit.
    const name = docName.canvasSpace(PID, SID);
    const doc = getDoc(name);
    const undo = getCanvasUndoManager(doc, name);
    addNode(PID, SID, annotation());
    undo.stopCapturing();
    editAnnotationBody(PID, SID, NID, 'a cooler, slower shot', 1_757_000_200_000);

    undo.undo();
    expect(dataMap().get('content')).toBe('a cooler shot here');
    // The note had never been rewritten, so the way back is no stamp at all —
    // the entry stops saying "edited", which is what it said before.
    expect(dataMap().get('editedAt')).toBeUndefined();

    undo.redo();
    expect(dataMap().get('content')).toBe('a cooler, slower shot');
    expect(dataMap().get('editedAt')).toBe(1_757_000_200_000);
  });

  it('takes a reply rewrite back the same way', () => {
    const name = docName.canvasSpace(PID, SID);
    const doc = getDoc(name);
    const undo = getCanvasUndoManager(doc, name);
    addNode(PID, SID, annotation());
    addReply(PID, SID, NID, {
      id: 'r1',
      content: 'agreed',
      createdBy: 'u-other',
      createdAt: 1_757_000_100_000,
    });
    undo.stopCapturing();
    editReply(PID, SID, NID, 'r1', 'agreed, slower', 1_757_000_300_000);

    undo.undo();
    const reply = (dataMap().get('replies') as Y.Array<Y.Map<unknown>>).get(0);
    expect(reply.get('content')).toBe('agreed');
    expect(reply.get('editedAt')).toBeUndefined();

    undo.redo();
    expect(reply.get('content')).toBe('agreed, slower');
    expect(reply.get('editedAt')).toBe(1_757_000_300_000);
  });
});

describe('undoing a deleted sticky (#1881 A16)', () => {
  it('brings the note and every reply on it back in one step', () => {
    // Deleting a note takes its replies with it, because they live inside its
    // own data map — which is the whole reason section 8.3 asks for no confirm
    // dialog: one undo is the way back. The restore is Yjs re-creating a
    // deleted item's parent type before re-inserting its children, so nothing
    // here holds it still except this.
    const name = docName.canvasSpace(PID, SID);
    const doc = getDoc(name);
    const undo = getCanvasUndoManager(doc, name);
    addNode(PID, SID, annotation());
    addReply(PID, SID, NID, {
      id: 'r1',
      content: 'somebody else wrote this',
      createdBy: 'u-other',
      createdAt: 1_757_000_100_000,
    });
    // A fresh stop, so the undo takes the deletion and nothing before it.
    undo.stopCapturing();
    removeNode(PID, SID, NID);
    expect(readNodes(doc)).toHaveLength(0);

    undo.undo();
    const back = readNodes(doc);
    expect(back).toHaveLength(1);
    const view = back[0]?.data;
    expect(view).toMatchObject({ kind: 'annotation', content: 'a cooler shot here' });
    expect(
      (view as { replies: { content: string }[] }).replies.map((r) => r.content),
    ).toEqual(['somebody else wrote this']);
  });
});
