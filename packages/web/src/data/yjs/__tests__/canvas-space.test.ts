// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addEdge,
  addNode,
  addToGroup,
  createCanvasUndoManager,
  moveGroup,
  readEdges,
  readNodes,
  removeEdge,
  removeFromGroup,
  removeNode,
  runCanvasUndoBatch,
  setGroupBackground,
  setNodeContent,
  setNodeError,
  setNodeHandling,
  setNodeLocked,
  setNodeName,
  setNodePosition,
} from '@web/data/yjs/canvas-space';

/**
 * Builds a complete wire {@link CanvasNodeFields} fixture.
 * @param type - The node modality (wire `type`).
 * @param data - Partial data overrides merged onto the required-field defaults.
 * @param opts - Optional id / position overrides.
 * @returns A complete CanvasNodeFields object.
 */
function sampleFields(
  type: NodeType,
  data: Partial<CanvasNodeFields['data']> = {},
  opts: { id?: string; position?: { x: number; y: number } } = {},
): CanvasNodeFields {
  return {
    id: opts.id ?? 'n1',
    type,
    position: opts.position ?? { x: 10, y: 20 },
    data: {
      name: 'N',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
      ...data,
    },
  };
}

const PID = 'p1';
const SID = 's1';

/**
 * Returns the live canvas Y.Doc for the test project/space.
 * @returns The cached canvas-space Y.Doc.
 */
function doc(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

describe('canvas-space Yjs binding — wire alignment with the backend', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('stores nodes under the top-level "nodesMap" (not "nodes") with a nested data Y.Map', () => {
    addNode(PID, SID, sampleFields('image', { content: 'x.png' }));

    // The backend (task-listener.ts) reads doc.getMap("nodesMap"); a node
    // stored under any other key is invisible to backend write-back.
    expect(doc().getMap('nodesMap').size).toBe(1);
    expect(doc().getMap('nodes').size).toBe(0);

    // The backend requires node.get("data") instanceof Y.Map — a plain
    // object would be skipped, which is the original contract-drift bug.
    const nodeMap = doc().getMap('nodesMap').get('n1');
    expect(nodeMap).toBeInstanceOf(Y.Map);
    expect((nodeMap as Y.Map<unknown>).get('data')).toBeInstanceOf(Y.Map);
    expect((nodeMap as Y.Map<unknown>).get('type')).toBe('image');
  });

  it('round-trips a node back to its narrowed view', () => {
    addNode(PID, SID, sampleFields('image', { content: 'x.png' }, { position: { x: 5, y: 6 } }));
    expect(readNodes(doc())).toEqual([
      {
        id: 'n1',
        type: 'image',
        position: { x: 5, y: 6 },
        data: {
          kind: 'image',
          name: 'N',
          content: 'x.png',
          status: 'idle',
          errorMessage: undefined,
          locked: false,
        },
      },
    ]);
  });

  it('surfaces a backend write-back into the data Y.Map (the contract-drift fix)', () => {
    // A node enters handling (frontend created it, backend is producing it).
    addNode(
      PID,
      SID,
      sampleFields('image', {
        state: 'handling',
        handlingBy: { userId: 'u1', type: 'backend' },
      }),
    );

    // Simulate exactly what collab task-listener.ts does: reach into the
    // node's data Y.Map and write the result fields.
    const d = doc();
    const dataMap = (d.getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    d.transact(() => {
      dataMap.set('content', 'result.png');
      dataMap.set('state', 'idle');
      dataMap.delete('handlingBy');
    });

    const view = readNodes(d)[0];
    expect(view.data).toEqual({
      kind: 'image',
      name: 'N',
      content: 'result.png',
      status: 'idle',
      errorMessage: undefined,
      locked: false,
    });
  });

  it('derives the error display status from idle + errorMessage written back', () => {
    addNode(PID, SID, sampleFields('image', { state: 'handling' }));
    const d = doc();
    const dataMap = (d.getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    d.transact(() => {
      dataMap.set('state', 'idle');
      dataMap.set('errorMessage', 'provider 500');
    });
    expect(readNodes(d)[0].data).toMatchObject({
      status: 'error',
      errorMessage: 'provider 500',
    });
  });

  it('includes group nodes now that they have a view (only dirty types skip)', () => {
    // Model revision 2026-06-15: group is rendered, so readNodes keeps it.
    // generative is gone from the type union entirely.
    addNode(PID, SID, sampleFields('image', {}, { id: 'keep' }));
    addNode(
      PID,
      SID,
      sampleFields('group', { backgroundColor: '#eee', childIds: ['keep'] }, { id: 'grp' }),
    );
    const ids = readNodes(doc()).map((n) => n.id);
    expect(ids).toEqual(['keep', 'grp']);
  });

  it('removeNode deletes from nodesMap', () => {
    addNode(PID, SID, sampleFields('text', { content: 'hi' }));
    expect(readNodes(doc())).toHaveLength(1);
    removeNode(PID, SID, 'n1');
    expect(readNodes(doc())).toHaveLength(0);
  });

  it('setNodePosition updates the node position', () => {
    addNode(PID, SID, sampleFields('text', { content: 'hi' }));
    setNodePosition(PID, SID, 'n1', { x: 99, y: 88 });
    expect(readNodes(doc())[0].position).toEqual({ x: 99, y: 88 });
  });

  it('setNodeName writes the new name into the node data Y.Map', () => {
    addNode(PID, SID, sampleFields('image', { content: 'x' }));
    setNodeName(PID, SID, 'n1', 'Hero shot');
    expect(readNodes(doc())[0].data).toMatchObject({ name: 'Hero shot' });
  });

  it('setNodeLocked writes the lock flag into the node data Y.Map', () => {
    addNode(PID, SID, sampleFields('image', { content: 'x', locked: false }));
    setNodeLocked(PID, SID, 'n1', true);
    expect(readNodes(doc())[0].data).toMatchObject({ locked: true });
    setNodeLocked(PID, SID, 'n1', false);
    expect(readNodes(doc())[0].data).toMatchObject({ locked: false });
  });

  it('setNodeContent writes content + flips handling → idle (upload done)', () => {
    addNode(PID, SID, sampleFields('image', { state: 'handling' }));
    setNodeContent(PID, SID, 'n1', 'https://cdn/photo.png');
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('content')).toBe('https://cdn/photo.png');
    expect(data.get('state')).toBe('idle');
    expect(data.get('errorMessage')).toBeUndefined();
  });

  it('setNodeContent clears any prior errorMessage', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { state: 'idle', errorMessage: 'old fail' }),
    );
    setNodeContent(PID, SID, 'n1', 'https://cdn/photo.png');
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('errorMessage')).toBeUndefined();
  });

  it('setNodeError writes errorMessage + idle so deriveStatus shows error (upload fail)', () => {
    addNode(PID, SID, sampleFields('image', { state: 'handling' }));
    setNodeError(PID, SID, 'n1', 'Upload failed: photo.png');
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('errorMessage')).toBe('Upload failed: photo.png');
    expect(data.get('state')).toBe('idle');
  });

  it('addEdge / removeEdge round-trip under the edgesMap', () => {
    addEdge(PID, SID, {
      id: 'e1',
      source: 'a',
      target: 'b',
      kind: 'primary',
      toolId: 'crop',
    });
    expect(doc().getMap('edgesMap').size).toBe(1);
    expect(readEdges(doc())).toEqual([
      { id: 'e1', source: 'a', target: 'b', kind: 'primary', toolId: 'crop' },
    ]);

    removeEdge(PID, SID, 'e1');
    expect(readEdges(doc())).toHaveLength(0);
  });

  describe('group membership — addToGroup / removeFromGroup', () => {
    /** Read a group's childIds straight off the wire data Y.Map. */
    function childIds(groupId: string): string[] | undefined {
      const g = doc().getMap('nodesMap').get(groupId) as Y.Map<unknown> | undefined;
      const data = g?.get('data');
      return data instanceof Y.Map ? (data.get('childIds') as string[]) : undefined;
    }

    it('addToGroup appends a node to childIds, idempotent (no duplicate)', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['n1'] }, { id: 'g1' }));
      addToGroup(PID, SID, 'g1', 'n2');
      expect(childIds('g1')).toEqual(['n1', 'n2']);
      addToGroup(PID, SID, 'g1', 'n2');
      expect(childIds('g1')).toEqual(['n1', 'n2']);
    });

    it('addToGroup refuses to nest a group (a group is never a member — 不嵌套)', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['n1'] }, { id: 'g1' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['n2'] }, { id: 'g2' }));
      addToGroup(PID, SID, 'g1', 'g2');
      expect(childIds('g1')).toEqual(['n1']);
    });

    it('addToGroup moves a node from its old group to the new one (成员不相交)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'na' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['na', 'nb', 'nc'] }, { id: 'gA' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['nd'] }, { id: 'gB' }));
      addToGroup(PID, SID, 'gB', 'na');
      expect(childIds('gA')).toEqual(['nb', 'nc']);
      expect(childIds('gB')).toEqual(['nd', 'na']);
    });

    it('addToGroup dissolves the old group if the move leaves it with one member (≥2 invariant — #7)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'na' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['na', 'nb'] }, { id: 'gA' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['nd'] }, { id: 'gB' }));
      addToGroup(PID, SID, 'gB', 'na');
      // gA had 2 members; moving na out leaves only nb → gA auto-dissolves
      expect(doc().getMap('nodesMap').get('gA')).toBeUndefined();
      expect(childIds('gB')).toEqual(['nd', 'na']);
    });

    it('addToGroup deletes the old group when the moved node was its last child (删空组)', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['only'] }, { id: 'gA' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['x'] }, { id: 'gB' }));
      addToGroup(PID, SID, 'gB', 'only');
      expect(doc().getMap('nodesMap').get('gA')).toBeUndefined();
      expect(childIds('gB')).toEqual(['x', 'only']);
    });

    it('removeFromGroup removes a member; the group survives while ≥2 remain', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['n1', 'n2', 'n3'] }, { id: 'g1' }));
      removeFromGroup(PID, SID, 'g1', 'n1');
      expect(childIds('g1')).toEqual(['n2', 'n3']);
    });

    it('removeFromGroup dissolves a group left with a single member (≥2-member invariant — #7)', () => {
      // A group needs ≥2 members to mean anything; dragging one out of a
      // 2-member group leaves a lone node, so the group auto-dissolves. The
      // survivor carries no back-reference to the group, so deleting the group
      // node alone frees it.
      addNode(PID, SID, sampleFields('group', { childIds: ['n1', 'n2'] }, { id: 'g1' }));
      removeFromGroup(PID, SID, 'g1', 'n1');
      expect(doc().getMap('nodesMap').get('g1')).toBeUndefined();
    });

    it('removeFromGroup deletes the group when its last member leaves (不变量 1)', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['only'] }, { id: 'g1' }));
      removeFromGroup(PID, SID, 'g1', 'only');
      expect(doc().getMap('nodesMap').get('g1')).toBeUndefined();
    });

    it('deleting a member node detaches it from its group (no stale childId)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'm1' }));
      addNode(PID, SID, sampleFields('image', {}, { id: 'm2' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['m1', 'm2'] }, { id: 'g1' }));
      removeNode(PID, SID, 'm1');
      expect(childIds('g1')).toEqual(['m2']);
    });

    it('deleting a group last member deletes the empty group too (不变量 1)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'm1' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['m1'] }, { id: 'g1' }));
      removeNode(PID, SID, 'm1');
      expect(doc().getMap('nodesMap').get('g1')).toBeUndefined();
    });

    it('deleting the group node itself leaves its children intact (删组放回子节点)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'm1' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['m1'] }, { id: 'g1' }));
      removeNode(PID, SID, 'g1');
      expect(doc().getMap('nodesMap').get('g1')).toBeUndefined();
      expect(doc().getMap('nodesMap').get('m1')).toBeInstanceOf(Y.Map);
    });
  });

  describe('undo tracking — content / error writes excluded (spec §5, #8)', () => {
    it('setNodeContent does NOT push an undo entry (else undo strands the node in handling)', () => {
      const undo = createCanvasUndoManager(doc());
      addNode(PID, SID, sampleFields('image', { state: 'handling' }, { id: 'img1' }));
      const depth = undo.undoStack.length;
      setNodeContent(PID, SID, 'img1', 'https://cdn/x.png');
      expect(undo.undoStack.length).toBe(depth);
    });

    it('setNodeError does NOT push an undo entry', () => {
      const undo = createCanvasUndoManager(doc());
      addNode(PID, SID, sampleFields('image', { state: 'handling' }, { id: 'img1' }));
      const depth = undo.undoStack.length;
      setNodeError(PID, SID, 'img1', 'upload failed: pic.png');
      expect(undo.undoStack.length).toBe(depth);
    });

    it('structural writes (setNodePosition) STILL push an undo entry (regression guard)', () => {
      const undo = createCanvasUndoManager(doc());
      addNode(PID, SID, sampleFields('image', {}, { id: 'img1' }));
      const depth = undo.undoStack.length;
      setNodePosition(PID, SID, 'img1', { x: 99, y: 99 });
      expect(undo.undoStack.length).toBe(depth + 1);
    });

    it('setNodeHandling marks the node handling but does NOT push an undo entry (transient in-flight state)', () => {
      const undo = createCanvasUndoManager(doc());
      addNode(PID, SID, sampleFields('image', {}, { id: 'img1' }));
      const depth = undo.undoStack.length;
      setNodeHandling(PID, SID, 'img1');
      const node = doc().getMap('nodesMap').get('img1') as Y.Map<unknown>;
      expect((node.get('data') as Y.Map<unknown>).get('state')).toBe('handling');
      // CONTENT_WRITE origin, like content / error writes — a transient upload
      // state must not become an undo entry (#8).
      expect(undo.undoStack.length).toBe(depth);
    });
  });

  describe('drag-stop atomicity — one gesture = one undo entry (#3)', () => {
    /** Read a node's position off the wire node Y.Map. */
    function pos(nodeId: string): { x: number; y: number } | undefined {
      const n = doc().getMap('nodesMap').get(nodeId) as Y.Map<unknown> | undefined;
      return n?.get('position') as { x: number; y: number } | undefined;
    }

    it('a drag-out (move + dissolve) batched into one transaction is ONE undo entry; undo restores member position AND the group together', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'm1', position: { x: 0, y: 0 } }));
      addNode(PID, SID, sampleFields('image', {}, { id: 'm2', position: { x: 100, y: 0 } }));
      addNode(PID, SID, sampleFields('group', { childIds: ['m1', 'm2'] }, { id: 'g1' }));
      const undo = createCanvasUndoManager(doc());
      const depth = undo.undoStack.length;
      // onNodeDragStop dragging m2 far out of the 2-member group fires a position
      // write AND a removeFromGroup that dissolves the group (≤1 left). Wrapping
      // both in one batch makes the gesture a SINGLE atomic undo step.
      runCanvasUndoBatch(PID, SID, () => {
        setNodePosition(PID, SID, 'm2', { x: 9999, y: 9999 });
        removeFromGroup(PID, SID, 'g1', 'm2');
      });
      expect(doc().getMap('nodesMap').get('g1')).toBeUndefined(); // dissolved
      // ONE entry, not two: captureTimeout:0 made it two, so undo restored the
      // group while m2 was still far away → the phantom oversized empty group.
      expect(undo.undoStack.length).toBe(depth + 1);
      undo.undo();
      // Undo restored BOTH the group AND m2's original position atomically.
      expect(doc().getMap('nodesMap').get('g1')).toBeInstanceOf(Y.Map);
      expect(pos('m2')).toEqual({ x: 100, y: 0 });
    });

    it('a multi-node marquee move batched into one transaction is ONE undo entry; undo restores ALL nodes (#3 same root)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'a', position: { x: 0, y: 0 } }));
      addNode(PID, SID, sampleFields('image', {}, { id: 'b', position: { x: 50, y: 50 } }));
      const undo = createCanvasUndoManager(doc());
      const depth = undo.undoStack.length;
      runCanvasUndoBatch(PID, SID, () => {
        setNodePosition(PID, SID, 'a', { x: 10, y: 10 });
        setNodePosition(PID, SID, 'b', { x: 60, y: 60 });
      });
      expect(undo.undoStack.length).toBe(depth + 1); // one entry, not two
      undo.undo();
      // Both reverted by one undo — the bug left N separate entries, so undoing a
      // 5-node marquee move only moved one node back.
      expect(pos('a')).toEqual({ x: 0, y: 0 });
      expect(pos('b')).toEqual({ x: 50, y: 50 });
    });
  });

  describe('group background + move — setGroupBackground / moveGroup', () => {
    /** Read a group's backgroundColor off the wire data Y.Map. */
    function bg(groupId: string): unknown {
      const g = doc().getMap('nodesMap').get(groupId) as Y.Map<unknown> | undefined;
      const data = g?.get('data');
      return data instanceof Y.Map ? data.get('backgroundColor') : undefined;
    }
    /** Read a node's position off the wire node Y.Map. */
    function pos(nodeId: string): { x: number; y: number } | undefined {
      const n = doc().getMap('nodesMap').get(nodeId) as Y.Map<unknown> | undefined;
      return n?.get('position') as { x: number; y: number } | undefined;
    }

    it('setGroupBackground sets the group backgroundColor', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['n1'] }, { id: 'g1' }));
      setGroupBackground(PID, SID, 'g1', 'var(--color-status-info-bg)');
      expect(bg('g1')).toBe('var(--color-status-info-bg)');
    });

    it('setGroupBackground with undefined clears the color (无色)', () => {
      addNode(
        PID,
        SID,
        sampleFields('group', { childIds: ['n1'], backgroundColor: 'x' }, { id: 'g1' }),
      );
      setGroupBackground(PID, SID, 'g1', undefined);
      expect(bg('g1')).toBeUndefined();
    });

    it('moveGroup shifts every child node by the delta (group follows via derived geometry)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'c1', position: { x: 10, y: 20 } }));
      addNode(PID, SID, sampleFields('image', {}, { id: 'c2', position: { x: 30, y: 40 } }));
      addNode(PID, SID, sampleFields('group', { childIds: ['c1', 'c2'] }, { id: 'g1' }));
      moveGroup(PID, SID, 'g1', { x: 5, y: -3 });
      expect(pos('c1')).toEqual({ x: 15, y: 17 });
      expect(pos('c2')).toEqual({ x: 35, y: 37 });
    });

    it('moveGroup skips child ids that are not real nodes (robust)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'c1', position: { x: 0, y: 0 } }));
      addNode(PID, SID, sampleFields('group', { childIds: ['c1', 'ghost'] }, { id: 'g1' }));
      expect(() => moveGroup(PID, SID, 'g1', { x: 1, y: 1 })).not.toThrow();
      expect(pos('c1')).toEqual({ x: 1, y: 1 });
    });
  });
});
