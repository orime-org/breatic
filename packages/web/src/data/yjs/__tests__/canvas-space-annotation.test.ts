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
