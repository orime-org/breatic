// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';

// Same stub as the undo spec: the doc and its observers are real, only the
// transport is absent.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: null;
    synced: boolean;
    status: 'connected';
    authFailedReason: null;
  } => ({
    provider: null,
    synced: true,
    status: 'connected',
    authFailedReason: null,
  }),
}));

import {
  useCanvasSpace,
  addNode,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { getDoc, docName, _resetForTests } from '@web/data/yjs/manager';

/**
 * A minimal text node.
 * @param id - The node id.
 * @returns The wire fields.
 */
function makeNode(id: string): CanvasNodeFields {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      name: `node-${id}`,
      createdAt: 0,
      createdBy: 'tester',
      locked: false,
      attachments: [],
    },
  };
}

describe('useCanvasSpace 交出「这批节点是谁写的」（#2000）', () => {
  beforeEach(() => {
    _resetCanvasUndoCacheForTests();
    _resetForTests();
  });

  it('本地写 true，收到对端的更新 false', () => {
    const p = 'proj-author';
    const s = 'space-author';
    const { result } = renderHook(() => useCanvasSpace(p, s));
    const doc = getDoc(docName.canvasSpace(p, s));

    // Nothing has happened yet: a document that just loaded carries no peer's
    // doing, so the first read counts as local.
    expect(result.current.getLastWriteWasLocal()).toBe(true);

    act(() => addNode(p, s, makeNode('A')));
    expect(result.current.nodes.map((n) => n.id)).toEqual(['A']);
    expect(result.current.getLastWriteWasLocal()).toBe(true);

    // A peer's write arrives the only way it ever does — as an update applied
    // to this doc. Yjs opens that transaction with local: false.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.transact(() => {
      peer.getMap<Y.Map<unknown>>('nodesMap').delete('A');
    });
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'peer');
    });

    expect(result.current.nodes).toHaveLength(0);
    expect(result.current.getLastWriteWasLocal()).toBe(false);

    // And back: this client writing again returns the flag to local.
    act(() => addNode(p, s, makeNode('B')));
    expect(result.current.getLastWriteWasLocal()).toBe(true);
  });

  it('the getter answers a peer write before any effect of that commit runs', () => {
    // A consumer that reacts to a document change does so inside an effect,
    // and effects run child-first: a child reading a copy the canvas above it
    // mirrored in ITS effect gets the previous write's author on the very
    // commit that matters. This getter reads what the document handler
    // recorded, which is already current when the render begins.
    const p = 'proj-author-getter';
    const s = 'space-author-getter';
    const { result } = renderHook(() => useCanvasSpace(p, s));
    const doc = getDoc(docName.canvasSpace(p, s));
    const seenDuringRender: boolean[] = [];

    act(() => addNode(p, s, makeNode('A')));
    expect(result.current.getLastWriteWasLocal()).toBe(true);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.transact(() => {
      peer.getMap<Y.Map<unknown>>('nodesMap').delete('A');
    });

    // Read it the moment the change lands, before React renders anything.
    const stopWatching = doc.on('afterTransaction', () => {
      seenDuringRender.push(result.current.getLastWriteWasLocal());
    });
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'peer');
    });
    doc.off('afterTransaction', stopWatching as never);

    expect(seenDuringRender).toContain(false);
    expect(result.current.getLastWriteWasLocal()).toBe(false);
  });

  it('keeps one reference across renders, so passing it down costs nothing', () => {
    const p = 'proj-author-stable';
    const s = 'space-author-stable';
    const { result } = renderHook(() => useCanvasSpace(p, s));
    const first = result.current.getLastWriteWasLocal;

    act(() => addNode(p, s, makeNode('A')));

    expect(result.current.getLastWriteWasLocal).toBe(first);
  });
});

describe('which notes a peer deleted (#1881)', () => {
  beforeEach(() => {
    _resetCanvasUndoCacheForTests();
    _resetForTests();
  });

  it('names the ids a peer removed, and keeps naming them after other writes', () => {
    // "Who deleted this note" is what the sticky's "this note was deleted"
    // asks, and a board-wide "who wrote last" answers a different question:
    // one unrelated write between the delete and the read — the collab server
    // writing taskCounts into a generating node is a routine one — flips it.
    const p = 'proj-deleted';
    const s = 'space-deleted';
    const { result } = renderHook(() => useCanvasSpace(p, s));
    const doc = getDoc(docName.canvasSpace(p, s));

    act(() => addNode(p, s, makeNode('A')));
    act(() => addNode(p, s, makeNode('B')));
    expect(result.current.deletedByPeer('A')).toBe(false);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.transact(() => {
      peer.getMap<Y.Map<unknown>>('nodesMap').delete('A');
    });
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'peer');
    });

    expect(result.current.deletedByPeer('A')).toBe(true);
    expect(result.current.deletedByPeer('B')).toBe(false);

    // Any other write landing before the reader's effect reads it leaves the
    // answer alone — that is the whole point of naming the id.
    act(() => addNode(p, s, makeNode('C')));
    expect(result.current.deletedByPeer('A')).toBe(true);
  });

  it('stops naming a note the peer put back', () => {
    // Undo is the way back from a delete (#1881 section 8.3 asks for no
    // confirm dialog because of it), so a note that was removed and restored
    // is an ordinary sight. The question this answers is "is the note that is
    // on the board right now gone because a peer removed it" — and a note
    // that is on the board is not gone. Left naming it, the reader's own
    // delete of that note later comes back to them as somebody else's.
    const p = 'proj-restored';
    const s = 'space-restored';
    const { result } = renderHook(() => useCanvasSpace(p, s));
    const doc = getDoc(docName.canvasSpace(p, s));

    act(() => addNode(p, s, makeNode('A')));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerUndo = new Y.UndoManager(
      peer.getMap<Y.Map<unknown>>('nodesMap'),
    );
    peer.transact(() => {
      peer.getMap<Y.Map<unknown>>('nodesMap').delete('A');
    });
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'peer');
    });
    expect(result.current.deletedByPeer('A')).toBe(true);

    peerUndo.undo();
    act(() => {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'peer');
    });
    expect(result.current.nodes.map((n) => n.id)).toEqual(['A']);
    expect(result.current.deletedByPeer('A')).toBe(false);
  });

  it('does not name a note this end deleted itself', () => {
    const p = 'proj-mine';
    const s = 'space-mine';
    const { result } = renderHook(() => useCanvasSpace(p, s));
    const doc = getDoc(docName.canvasSpace(p, s));

    act(() => addNode(p, s, makeNode('A')));
    act(() => {
      doc.transact(() => {
        doc.getMap<Y.Map<unknown>>('nodesMap').delete('A');
      });
    });
    expect(result.current.deletedByPeer('A')).toBe(false);
  });
});
