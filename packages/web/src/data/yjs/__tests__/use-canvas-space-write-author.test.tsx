// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
      state: 'idle',
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
    expect(result.current.lastWriteWasLocal).toBe(true);

    act(() => addNode(p, s, makeNode('A')));
    expect(result.current.nodes.map((n) => n.id)).toEqual(['A']);
    expect(result.current.lastWriteWasLocal).toBe(true);

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
    expect(result.current.lastWriteWasLocal).toBe(false);

    // And back: this client writing again returns the flag to local.
    act(() => addNode(p, s, makeNode('B')));
    expect(result.current.lastWriteWasLocal).toBe(true);
  });
});
