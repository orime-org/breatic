// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CanvasNodeFields } from '@breatic/shared';

// Mock the socket so renderHook(useCanvasSpace) works on a pure in-memory
// Y.Doc and never opens a real WebSocket (useCanvasSpace → useSocket →
// HocuspocusProvider). The doc + UndoManager are real; only the transport
// is stubbed.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: (): {
    provider: null;
    synced: boolean;
    status: 'connected';
    authFailedReason: null;
  } => ({ provider: null, synced: true, status: 'connected', authFailedReason: null }),
}));

import {
  useCanvasSpace,
  addNode,
  setNodePosition,
} from '@web/data/yjs/canvas-space';
import { getDoc, docName, _resetForTests } from '@web/data/yjs/manager';

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
      operationLocks: [],
      state: 'idle',
      attachments: [],
    },
  };
}

describe('useCanvasSpace canUndo mirror — collaborator deletes a tracked node', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('canUndo flips to false after undo() drains a dead stack (yjs fires no stack-item-popped)', () => {
    const p = 'proj-undo-collab';
    const s = 'space-undo-collab';
    const name = docName.canvasSpace(p, s);
    const { result } = renderHook(() => useCanvasSpace(p, s));
    const doc = getDoc(name);
    const nodesMap = doc.getMap<unknown>('nodesMap');

    // A creates D, then moves D — two tracked entries on A's undo stack.
    act(() => {
      addNode(p, s, makeNode('D'));
      setNodePosition(p, s, 'D', { x: 50, y: 50 });
    });
    expect(result.current.canUndo).toBe(true);

    // B (a collaborator) deletes D — a remote, NON-tracked write (its origin
    // is not CANVAS_UNDO, so A's manager does not capture it). The two stack
    // entries are now "dead": their target node is tombstoned.
    act(() => {
      doc.transact(() => nodesMap.delete('D'), 'remote');
    });
    // The dead entries are still on the stack, so the button still shows
    // enabled until A actually clicks (matches plain yjs length-based canUndo).
    expect(result.current.canUndo).toBe(true);

    // A clicks undo. yjs's popStackItem drains BOTH dead entries (undoing a
    // create / move of a remotely-deleted node performs no change), leaving
    // the stack empty — but emits NO 'stack-item-popped' event because no
    // change was performed. The event-driven mirror would therefore stay
    // stale at `true`, leaving the button stuck enabled and clickable forever
    // (the reported bug). The fix re-reads availability after undo().
    act(() => {
      result.current.undo();
    });
    expect(result.current.canUndo).toBe(false);

    // And a second click is a true no-op: the stack is already empty.
    act(() => {
      result.current.undo();
    });
    expect(result.current.canUndo).toBe(false);
  });
});
