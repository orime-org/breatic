// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields } from '@breatic/shared';

import {
  CANVAS_UNDO,
  MAX_UNDO_DEPTH,
  createCanvasUndoManager,
  addNode,
  removeNode,
  setNodePosition,
  setNodeName,
  setNodeLocked,
  addEdge,
  removeEdge,
  removeElements,
} from '@web/data/yjs/canvas-space';
import { getDoc, docName, _resetForTests } from '@web/data/yjs/manager';

/** Backend content writes carry this origin (collab task-listener) — must NOT be tracked. */
const NODE_STATE_UPDATE = 'node-state-update';

let counter = 0;
/** A fresh per-space doc obtained via the same getDoc cache the write fns use. */
function space(): { p: string; s: string; doc: Y.Doc } {
  counter += 1;
  const p = `proj-${counter}`;
  const s = `space-${counter}`;
  return { p, s, doc: getDoc(docName.canvasSpace(p, s)) };
}

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

const nodesOf = (doc: Y.Doc): Y.Map<Y.Map<unknown>> =>
  doc.getMap<Y.Map<unknown>>('nodesMap');
const edgesOf = (doc: Y.Doc): Y.Map<Y.Map<unknown>> =>
  doc.getMap<Y.Map<unknown>>('edgesMap');
const lockedOf = (doc: Y.Doc, id: string): unknown =>
  (nodesOf(doc).get(id)?.get('data') as Y.Map<unknown>).get('locked');
const nameOf = (doc: Y.Doc, id: string): unknown =>
  (nodesOf(doc).get(id)?.get('data') as Y.Map<unknown>).get('name');

/** Wire two docs as collaborators: each local update propagates with a non-tracked 'remote' origin. */
function connect(a: Y.Doc, b: Y.Doc): void {
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b, update, 'remote');
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a, update, 'remote');
  });
}

describe('canvas undo/redo (Y.UndoManager)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('a fresh manager starts empty (page refresh = new JS context = empty stack)', () => {
    const { doc } = space();
    const um = createCanvasUndoManager(doc);
    expect(um.undoStack.length).toBe(0);
    expect(um.canUndo()).toBe(false);
  });

  it('captures a tracked write and undo reverts it', () => {
    const { p, s, doc } = space();
    const um = createCanvasUndoManager(doc);
    addNode(p, s, makeNode('a'));
    expect(um.undoStack.length).toBe(1);
    expect(nodesOf(doc).has('a')).toBe(true);
    um.undo();
    expect(nodesOf(doc).has('a')).toBe(false);
    um.redo();
    expect(nodesOf(doc).has('a')).toBe(true);
  });

  it('all seven write functions are tracked, one entry each', () => {
    const { p, s, doc } = space();
    // Seed two nodes BEFORE the manager so the create ops are not on the stack.
    addNode(p, s, makeNode('a'));
    addNode(p, s, makeNode('b'));
    const um = createCanvasUndoManager(doc);
    setNodePosition(p, s, 'a', { x: 5, y: 5 });
    setNodeName(p, s, 'a', 'renamed');
    setNodeLocked(p, s, 'a', true);
    addEdge(p, s, { id: 'e1', source: 'a', target: 'b' });
    removeEdge(p, s, 'e1');
    removeNode(p, s, 'b');
    // 6 tracked ops (the two creates were before the manager).
    expect(um.undoStack.length).toBe(6);
  });

  it('caps the undo stack at MAX_UNDO_DEPTH (drops the oldest)', () => {
    const { p, s, doc } = space();
    const um = createCanvasUndoManager(doc);
    for (let i = 0; i < MAX_UNDO_DEPTH + 12; i += 1) addNode(p, s, makeNode(`n${i}`));
    expect(um.undoStack.length).toBe(MAX_UNDO_DEPTH);
  });

  it('name edit is tracked; a backend content write (node-state-update origin) is NOT', () => {
    const { p, s, doc } = space();
    addNode(p, s, makeNode('a')); // before manager
    const um = createCanvasUndoManager(doc);
    setNodeName(p, s, 'a', 'newname');
    expect(um.undoStack.length).toBe(1);
    expect(nameOf(doc, 'a')).toBe('newname');
    // Backend writes content into the same nested data Y.Map, but with its own origin.
    const data = nodesOf(doc).get('a')?.get('data') as Y.Map<unknown>;
    doc.transact(() => {
      data.set('content', 'generated-by-worker');
    }, NODE_STATE_UPDATE);
    // The content write must not enter the undo stack.
    expect(um.undoStack.length).toBe(1);
    um.undo(); // undoes the name edit only
    expect(nameOf(doc, 'a')).toBe('node-a');
    expect(data.get('content')).toBe('generated-by-worker'); // content survives undo
  });

  it('create then lock: undo unlocks first, then deletes (no "delete a locked node")', () => {
    const { p, s, doc } = space();
    const um = createCanvasUndoManager(doc);
    addNode(p, s, makeNode('a')); // entry 1
    setNodeLocked(p, s, 'a', true); // entry 2
    expect(lockedOf(doc, 'a')).toBe(true);
    um.undo(); // undo lock
    expect(nodesOf(doc).has('a')).toBe(true);
    expect(lockedOf(doc, 'a')).toBe(false);
    um.undo(); // undo create
    expect(nodesOf(doc).has('a')).toBe(false);
  });

  it('per-user isolation: client A undo does not revert client B op', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    connect(docA, docB);
    const umA = createCanvasUndoManager(docA);
    createCanvasUndoManager(docB);
    docA.transact(() => {
      nodesOf(docA).set('a', new Y.Map());
    }, CANVAS_UNDO);
    docB.transact(() => {
      nodesOf(docB).set('b', new Y.Map());
    }, CANVAS_UNDO);
    // Both nodes are now on both docs (synced).
    expect(nodesOf(docA).has('a')).toBe(true);
    expect(nodesOf(docA).has('b')).toBe(true);
    umA.undo(); // A undoes ONLY its own create of 'a'
    expect(nodesOf(docA).has('a')).toBe(false);
    expect(nodesOf(docA).has('b')).toBe(true); // B's op survives A's undo
    expect(nodesOf(docB).has('b')).toBe(true);
  });

  it('removeElements deletes a node and its edge in ONE atomic undo entry', () => {
    const { p, s, doc } = space();
    addNode(p, s, makeNode('a'));
    addNode(p, s, makeNode('b'));
    addEdge(p, s, { id: 'e1', source: 'a', target: 'b' });
    const um = createCanvasUndoManager(doc);
    // Deleting node 'b' cascades its edge 'e1' — both go in one transaction.
    removeElements(p, s, ['b'], ['e1']);
    expect(um.undoStack.length).toBe(1); // ONE entry, not two
    expect(nodesOf(doc).has('b')).toBe(false);
    expect(edgesOf(doc).has('e1')).toBe(false);
    um.undo();
    // A single undo must restore BOTH the node and its edge (the reported bug:
    // node came back but the edge did not, because they were two entries).
    expect(nodesOf(doc).has('b')).toBe(true);
    expect(edgesOf(doc).has('e1')).toBe(true);
  });

  it('A decision: undo does not overwrite a collaborator property value (ignoreRemoteMapChanges false)', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    // Seed a shared node 'a' on both BEFORE connecting the managers.
    docA.transact(() => {
      const node = new Y.Map<unknown>();
      const data = new Y.Map<unknown>();
      data.set('position', { x: 0, y: 0 });
      node.set('data', data);
      nodesOf(docA).set('a', node);
    });
    connect(docA, docB);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), 'remote');
    const umA = createCanvasUndoManager(docA);
    const dataA = nodesOf(docA).get('a')?.get('data') as Y.Map<unknown>;
    const dataB = (): Y.Map<unknown> =>
      nodesOf(docB).get('a')?.get('data') as Y.Map<unknown>;
    // A moves the node (tracked); B then moves it elsewhere (after A).
    docA.transact(() => dataA.set('position', { x: 10, y: 10 }), CANVAS_UNDO);
    docB.transact(() => dataB().set('position', { x: 99, y: 99 }), CANVAS_UNDO);
    // A undoes its move — must NOT clobber B's newer position.
    umA.undo();
    expect((dataA.get('position') as { x: number }).x).toBe(99);
  });
});
