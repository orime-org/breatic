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
  readEdges,
  readNodes,
  removeEdge,
  removeFromGroup,
  removeNode,
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
      addNode(PID, SID, sampleFields('group', { childIds: ['na', 'nb'] }, { id: 'gA' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['nc'] }, { id: 'gB' }));
      addToGroup(PID, SID, 'gB', 'na');
      expect(childIds('gA')).toEqual(['nb']);
      expect(childIds('gB')).toEqual(['nc', 'na']);
    });

    it('addToGroup deletes the old group when the moved node was its last child (删空组)', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['only'] }, { id: 'gA' }));
      addNode(PID, SID, sampleFields('group', { childIds: ['x'] }, { id: 'gB' }));
      addToGroup(PID, SID, 'gB', 'only');
      expect(doc().getMap('nodesMap').get('gA')).toBeUndefined();
      expect(childIds('gB')).toEqual(['x', 'only']);
    });

    it('removeFromGroup removes a member; the group survives while others remain', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['n1', 'n2'] }, { id: 'g1' }));
      removeFromGroup(PID, SID, 'g1', 'n1');
      expect(childIds('g1')).toEqual(['n2']);
    });

    it('removeFromGroup deletes the group when its last member leaves (不变量 1)', () => {
      addNode(PID, SID, sampleFields('group', { childIds: ['only'] }, { id: 'g1' }));
      removeFromGroup(PID, SID, 'g1', 'only');
      expect(doc().getMap('nodesMap').get('g1')).toBeUndefined();
    });
  });
});
