// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addEdge,
  addNode,
  createCanvasUndoManager,
  createGroup,
  expandGroup,
  readEdges,
  readNodes,
  removeEdge,
  removeNode,
  resizeGroup,
  runCanvasUndoBatch,
  setGroupBackground,
  getOrCreatePromptFragment,
  isNodeLocked,
  nodeExists,
  setNodeStyleImage,
  addNodeFocusImage,
  removeNodeFocusImage,
  clearNodeStyleImage,
  readCanvasGraph,
  readNodeLeaseGen,
  setNodeContent,
  setNodeHandling,
  completeNodeHandling,
  failNodeHandling,
  isNodeHandling,
  setNodeLocked,
  setNodeMode,
  setNodeModel,
  setNodeName,
  setNodeParams,
  setNodeParent,
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
  opts: { id?: string; position?: { x: number; y: number }; parentId?: string } = {},
): CanvasNodeFields {
  return {
    id: opts.id ?? 'n1',
    type,
    ...(opts.parentId !== undefined ? { parentId: opts.parentId } : {}),
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

  it('persists and round-trips a member node parentId (Group containment)', () => {
    // Group redesign (2026-06-23): a member binds to its Group via a top-level
    // `parentId` (alongside `position`, not in `data`). readNodes surfaces it
    // so `toFlowNode` can hand ReactFlow a parented node.
    addNode(PID, SID, sampleFields('image', {}, { id: 'm', parentId: 'f1' }));
    const nodeMap = doc().getMap('nodesMap').get('m') as Y.Map<unknown>;
    expect(nodeMap.get('parentId')).toBe('f1');
    expect(readNodes(doc()).find((n) => n.id === 'm')?.parentId).toBe('f1');
  });

  it('omits parentId on the view for a top-level node (no stray key)', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'top' }));
    expect('parentId' in (readNodes(doc())[0] as object)).toBe(false);
  });

  it('surfaces a backend write-back into the data Y.Map (the contract-drift fix)', () => {
    // A node enters handling (frontend created it, backend is producing it).
    addNode(
      PID,
      SID,
      sampleFields('image', {
        state: 'handling',
        handlingBy: { userId: 'u1', type: 'backend', startedAt: 1_700_000_000_000, gen: 1 },
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
      sampleFields('group', { backgroundColor: '#eee' }, { id: 'grp' }),
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

  it('setNodeContent (plain writer — text inline edit) writes content + flips handling → idle', () => {
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

  it('failNodeHandling writes errorMessage + idle so deriveStatus shows error (upload fail)', () => {
    addNode(PID, SID, sampleFields('image'));
    const lease = setNodeHandling(PID, SID, 'n1', 'u1');
    expect(lease).toBeDefined();
    failNodeHandling(PID, SID, 'n1', 'Upload failed: photo.png', lease!);
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('errorMessage')).toBe('Upload failed: photo.png');
    expect(data.get('state')).toBe('idle');
  });

  it('addEdge / removeEdge round-trip under the edgesMap', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'a' }));
    addNode(PID, SID, sampleFields('image', {}, { id: 'b' }));
    addEdge(PID, SID, {
      id: 'e1',
      source: 'a',
      target: 'b',
      toolId: 'crop',
    });
    expect(doc().getMap('edgesMap').size).toBe(1);
    expect(readEdges(doc())).toEqual([
      {
        id: 'e1',
        source: 'a',
        target: 'b',
        toolId: 'crop',
        createdAt: expect.any(Number) as number,
      },
    ]);

    removeEdge(PID, SID, 'e1');
    expect(readEdges(doc())).toHaveLength(0);
  });

  // Connection timestamp (batch-2 item 7): the reference rail orders rows by
  // when the connection was drawn. Y.Map iteration order is struct-store order
  // (clientID+clock), NOT insertion order after reload / sync, so the fact
  // "when was this edge created" must be stored on the edge itself.
  it('addEdge stamps createdAt (epoch ms) and readEdges round-trips it', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'a' }));
    addNode(PID, SID, sampleFields('image', {}, { id: 'b' }));
    const t0 = Date.now();
    addEdge(PID, SID, { id: 'a->b', source: 'a', target: 'b' });
    const t1 = Date.now();
    const [read] = readEdges(doc());
    expect(typeof read.createdAt).toBe('number');
    expect(read.createdAt).toBeGreaterThanOrEqual(t0);
    expect(read.createdAt).toBeLessThanOrEqual(t1);
  });

  // Adversarial (batch-2 round-1): a corrupt stamp written by a modified
  // client (string / NaN) must not pass the read boundary — the sort
  // comparator would return NaN and TimSort silently leaves HEALTHY edges
  // around it un-sorted. Same untrusted-Yjs convention as readNodeLeaseGen.
  it('readEdges drops a non-finite / non-number createdAt (corrupt collaborative data)', () => {
    for (const [id, bad] of [
      ['corrupt-str', '2026-07-11'],
      ['corrupt-nan', Number.NaN],
    ] as const) {
      const map = new Y.Map<unknown>();
      map.set('id', id);
      map.set('source', 'a');
      map.set('target', 'b');
      map.set('createdAt', bad);
      doc().getMap<Y.Map<unknown>>('edgesMap').set(id, map);
    }
    for (const read of readEdges(doc())) {
      expect(read.createdAt).toBeUndefined();
    }
  });

  // Adversarial (batch-2 round-1): the deterministic id `source->target`
  // means a duplicate drag maps to an EXISTING map entry. An unconditional
  // set() would replace it with a fresh createdAt — silently teleporting the
  // reference from first to last in the rail and pushing a spurious undo
  // entry. A duplicate connect is an idempotent success instead.
  it('addEdge is idempotent for an existing edge id (keeps the original stamp, no rewrite)', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'a' }));
    addNode(PID, SID, sampleFields('image', {}, { id: 'b' }));
    expect(addEdge(PID, SID, { id: 'a->b', source: 'a', target: 'b' })).toBe(
      true,
    );
    const first = readEdges(doc())[0].createdAt;
    expect(
      addEdge(PID, SID, {
        id: 'a->b',
        source: 'a',
        target: 'b',
        createdAt: (first ?? 0) + 99999,
      }),
    ).toBe(true);
    expect(readEdges(doc())).toHaveLength(1);
    expect(readEdges(doc())[0].createdAt).toBe(first);
  });

  it('readEdges leaves createdAt undefined for a legacy edge that predates the stamp', () => {
    // Simulate an old-document edge written before createdAt existed.
    const map = new Y.Map<unknown>();
    map.set('id', 'legacy');
    map.set('source', 'a');
    map.set('target', 'b');
    doc().getMap<Y.Map<unknown>>('edgesMap').set('legacy', map);
    const [read] = readEdges(doc());
    expect(read.createdAt).toBeUndefined();
  });

  it('addEdge returns true when the edge lands and false when rejected', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'a' }));
    addNode(PID, SID, sampleFields('image', {}, { id: 'b' }));
    expect(addEdge(PID, SID, { id: 'a->b', source: 'a', target: 'b' })).toBe(
      true,
    );
    // self-loop rejected
    expect(addEdge(PID, SID, { id: 'a->a', source: 'a', target: 'a' })).toBe(
      false,
    );
    // orphan (missing endpoint) rejected — both directions
    expect(
      addEdge(PID, SID, { id: 'a->ghost', source: 'a', target: 'ghost' }),
    ).toBe(false);
    expect(
      addEdge(PID, SID, { id: 'ghost->a', source: 'ghost', target: 'a' }),
    ).toBe(false);
    // only the valid edge landed
    expect(readEdges(doc())).toHaveLength(1);
  });

  it('readCanvasGraph reads live nodes + edges fresh', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'a' }));
    addNode(PID, SID, sampleFields('image', {}, { id: 'b' }));
    addEdge(PID, SID, { id: 'a->b', source: 'a', target: 'b' });
    const graph = readCanvasGraph(PID, SID);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(graph.edges).toEqual([
      {
        id: 'a->b',
        source: 'a',
        target: 'b',
        createdAt: expect.any(Number) as number,
      },
    ]);
  });

  it('setNodeParams writes the generate model params into the node data', () => {
    addNode(PID, SID, sampleFields('image'));
    setNodeParams(PID, SID, 'n1', { aspect_ratio: '16:9', resolution: '2K' });
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('params')).toEqual({ aspect_ratio: '16:9', resolution: '2K' });
  });

  it('setNodeModel writes model + params + records the mode memory in one transaction', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { mode: 't2i', model: 'old', params: { aspect_ratio: '1:1' } }),
    );
    setNodeModel(PID, SID, 'n1', 't2i', 'nano_banana_pro', { aspect_ratio: '16:9' });
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('model')).toBe('nano_banana_pro');
    expect(data.get('params')).toEqual({ aspect_ratio: '16:9' });
    // The pick is remembered under its mode so a later toggle back restores it.
    expect(data.get('modelByMode')).toEqual({ t2i: 'nano_banana_pro' });
  });

  it('setNodeModel merges the pick into an existing modelByMode, keeping other modes', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { mode: 't2i', modelByMode: { i2i: 'mj-i2i' } }),
    );
    setNodeModel(PID, SID, 'n1', 't2i', 'flux', {});
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('modelByMode')).toEqual({ i2i: 'mj-i2i', t2i: 'flux' });
  });

  it('setNodeMode writes mode + model + params atomically (toggle), NOT touching modelByMode', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', {
        mode: 't2i',
        model: 'flux',
        params: { aspect_ratio: '16:9' },
        modelByMode: { t2i: 'flux' },
      }),
    );
    // Toggle to i2i, selecting the resolved model + reconciled params for it.
    setNodeMode(PID, SID, 'n1', 'i2i', 'mj-i2i', { aspect_ratio: '1:1' });
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('mode')).toBe('i2i');
    expect(data.get('model')).toBe('mj-i2i');
    expect(data.get('params')).toEqual({ aspect_ratio: '1:1' });
    // A toggle is not an explicit pick — the per-mode memory is left as-is.
    expect(data.get('modelByMode')).toEqual({ t2i: 'flux' });
  });

  it('setNodeParams / setNodeModel / setNodeMode are no-ops when the node is missing', () => {
    expect(() => setNodeParams(PID, SID, 'ghost', {})).not.toThrow();
    expect(() => setNodeModel(PID, SID, 'ghost', 't2i', 'm', {})).not.toThrow();
    expect(() => setNodeMode(PID, SID, 'ghost', 't2i', 'm', {})).not.toThrow();
  });

  // ── Style image (#1664): frontend-owned pick-time URL copy, one max ──
  it('setNodeStyleImage stores the copied URL on the node data', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'gen' }));
    setNodeStyleImage(PID, SID, 'gen', 'https://cdn/style-a.png');
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('styleImageUrl')).toBe('https://cdn/style-a.png');
  });

  it('setNodeStyleImage overwrites a previous pick (re-pick replaces, one slot)', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { styleImageUrl: 'https://cdn/old.png' }, { id: 'gen' }),
    );
    setNodeStyleImage(PID, SID, 'gen', 'https://cdn/new.png');
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('styleImageUrl')).toBe('https://cdn/new.png');
  });

  it('clearNodeStyleImage deletes the key (absent = no style picked)', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { styleImageUrl: 'https://cdn/s.png' }, { id: 'gen' }),
    );
    clearNodeStyleImage(PID, SID, 'gen');
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.has('styleImageUrl')).toBe(false);
  });

  it('setNodeStyleImage / clearNodeStyleImage are no-ops when the node is missing', () => {
    expect(() => setNodeStyleImage(PID, SID, 'ghost', 'u')).not.toThrow();
    expect(() => clearNodeStyleImage(PID, SID, 'ghost')).not.toThrow();
  });

  // ── Focus images (#1782): frontend-owned crop copies, plain-array LWW ──
  const crop1 = {
    id: 'f1',
    url: 'https://cdn/crop-1.png',
    name: 'Image Node 26',
    width: 640,
    height: 360,
  };
  const crop2 = {
    id: 'f2',
    url: 'https://cdn/crop-2.png',
    name: 'Image Node 27',
    width: 320,
    height: 320,
  };

  it('addNodeFocusImage creates the array on first add and appends in order', () => {
    addNode(PID, SID, sampleFields('image', {}, { id: 'gen' }));
    addNodeFocusImage(PID, SID, 'gen', crop1);
    addNodeFocusImage(PID, SID, 'gen', crop2);
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('focusImages')).toEqual([crop1, crop2]);
  });

  it('removeNodeFocusImage removes by id and deletes the key when empty', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { focusImages: [crop1, crop2] }, { id: 'gen' }),
    );
    removeNodeFocusImage(PID, SID, 'gen', 'f1');
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('focusImages')).toEqual([crop2]);
    // Removing the last entry deletes the key — absent is the natural
    // "none created" state (mirrors clearNodeStyleImage).
    removeNodeFocusImage(PID, SID, 'gen', 'f2');
    expect(data.has('focusImages')).toBe(false);
  });

  it('removeNodeFocusImage with an unknown id is a no-op (no write, no undo entry)', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { focusImages: [crop1] }, { id: 'gen' }),
    );
    const undo = createCanvasUndoManager(doc());
    const depth = undo.undoStack.length;
    removeNodeFocusImage(PID, SID, 'gen', 'ghost-id');
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('focusImages')).toEqual([crop1]);
    expect(undo.undoStack.length).toBe(depth);
  });

  it('addNodeFocusImage / removeNodeFocusImage are no-ops when the node is missing', () => {
    expect(() => addNodeFocusImage(PID, SID, 'ghost', crop1)).not.toThrow();
    expect(() => removeNodeFocusImage(PID, SID, 'ghost', 'f1')).not.toThrow();
  });

  it('removeNodeFocusImage never throws on malformed remote entries and heals them (adversarial 2026-07-16)', () => {
    // Whole-array LWW means any client can write any shape; a null entry
    // used to make the ✕ click throw on `f.id`. Removal now sanitizes:
    // drops the removed id AND every malformed entry in the same write.
    addNode(
      PID,
      SID,
      sampleFields(
        'image',
        {
          focusImages: [crop1, null, { id: '', url: 'u', name: 'x' }, crop2] as unknown as
            typeof crop1[],
        },
        { id: 'gen' },
      ),
    );
    expect(() => removeNodeFocusImage(PID, SID, 'gen', 'f1')).not.toThrow();
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('focusImages')).toEqual([crop2]);
  });

  it('addNodeFocusImage heals malformed remote entries while appending', () => {
    addNode(
      PID,
      SID,
      sampleFields(
        'image',
        { focusImages: [null, crop1] as unknown as typeof crop1[] },
        { id: 'gen' },
      ),
    );
    addNodeFocusImage(PID, SID, 'gen', crop2);
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('focusImages')).toEqual([crop1, crop2]);
  });

  it('focus APPEND is a content arrival — NOT undo-tracked (CONTENT_WRITE, round-3)', () => {
    // The append lands asynchronously when the crop upload finishes — the
    // same rule as upload completion (#8): a slow upload landing seconds
    // later must not steal the undo top or wipe the redo stack.
    addNode(PID, SID, sampleFields('image', {}, { id: 'gen' }));
    const undo = createCanvasUndoManager(doc());
    const depth = undo.undoStack.length;
    addNodeFocusImage(PID, SID, 'gen', crop1);
    expect(undo.undoStack.length).toBe(depth);
  });

  it('focus REMOVE (a synchronous ✕ click) IS undoable (CANVAS_UNDO)', () => {
    addNode(
      PID,
      SID,
      sampleFields('image', { focusImages: [crop1] }, { id: 'gen' }),
    );
    const undo = createCanvasUndoManager(doc());
    const depth = undo.undoStack.length;
    expect(removeNodeFocusImage(PID, SID, 'gen', 'f1')).toBe(true);
    expect(undo.undoStack.length).toBe(depth + 1);
    undo.undo();
    const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('focusImages')).toEqual([crop1]);
  });

  it('removeNodeFocusImage answers whether the TARGET was removed (report gate, round-3)', () => {
    addNode(
      PID,
      SID,
      sampleFields(
        'image',
        { focusImages: [crop1, null] as unknown as typeof crop1[] },
        { id: 'gen' },
      ),
    );
    // Heal-only rewrite (unknown id, malformed entry dropped) = false.
    expect(removeNodeFocusImage(PID, SID, 'gen', 'ghost')).toBe(false);
    // Real removal = true; the repeat (already gone) = false.
    expect(removeNodeFocusImage(PID, SID, 'gen', 'f1')).toBe(true);
    expect(removeNodeFocusImage(PID, SID, 'gen', 'f1')).toBe(false);
    expect(removeNodeFocusImage(PID, SID, 'ghost-node', 'f1')).toBe(false);
  });

  it('getOrCreatePromptFragment creates + persists a Y.XmlFragment on the node prompt', () => {
    addNode(PID, SID, sampleFields('image'));
    const frag = getOrCreatePromptFragment(PID, SID, 'n1');
    expect(frag).toBeInstanceOf(Y.XmlFragment);
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('prompt')).toBe(frag);
  });

  it('getOrCreatePromptFragment returns the same fragment on repeat calls (idempotent)', () => {
    addNode(PID, SID, sampleFields('image'));
    expect(getOrCreatePromptFragment(PID, SID, 'n1')).toBe(
      getOrCreatePromptFragment(PID, SID, 'n1'),
    );
  });

  it('getOrCreatePromptFragment returns null for a missing node', () => {
    expect(getOrCreatePromptFragment(PID, SID, 'ghost')).toBeNull();
  });

  it('readNodeLeaseGen returns 0 for a node with no leaseGen and the stored value otherwise', () => {
    addNode(PID, SID, sampleFields('image'));
    expect(readNodeLeaseGen(PID, SID, 'n1')).toBe(0);
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    doc().transact(() => data.set('leaseGen', 4));
    expect(readNodeLeaseGen(PID, SID, 'n1')).toBe(4);
  });

  it('readNodeLeaseGen returns 0 for a missing node', () => {
    expect(readNodeLeaseGen(PID, SID, 'ghost')).toBe(0);
  });

  it('nodeExists reflects live presence (fresh Yjs read)', () => {
    expect(nodeExists(PID, SID, 'n1')).toBe(false);
    addNode(PID, SID, sampleFields('image'));
    expect(nodeExists(PID, SID, 'n1')).toBe(true);
  });

  it('isNodeLocked reflects the live lock state (fresh Yjs read)', () => {
    addNode(PID, SID, sampleFields('image', { locked: false }));
    expect(isNodeLocked(PID, SID, 'n1')).toBe(false);
    setNodeLocked(PID, SID, 'n1', true);
    expect(isNodeLocked(PID, SID, 'n1')).toBe(true);
    expect(isNodeLocked(PID, SID, 'ghost')).toBe(false);
  });

  describe('undo tracking — content / error writes excluded (spec §5, #8)', () => {
    it('setNodeContent does NOT push an undo entry (else undo strands the node in handling)', () => {
      const undo = createCanvasUndoManager(doc());
      addNode(PID, SID, sampleFields('image', { state: 'handling' }, { id: 'img1' }));
      const depth = undo.undoStack.length;
      setNodeContent(PID, SID, 'img1', 'https://cdn/x.png');
      expect(undo.undoStack.length).toBe(depth);
    });

    it('failNodeHandling does NOT push an undo entry', () => {
      const undo = createCanvasUndoManager(doc());
      addNode(PID, SID, sampleFields('image', {}, { id: 'img1' }));
      const lease = setNodeHandling(PID, SID, 'img1', 'u1');
      const depth = undo.undoStack.length;
      failNodeHandling(PID, SID, 'img1', 'upload failed: pic.png', lease!);
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
      setNodeHandling(PID, SID, 'img1', 'user-x');
      const node = doc().getMap('nodesMap').get('img1') as Y.Map<unknown>;
      expect((node.get('data') as Y.Map<unknown>).get('state')).toBe('handling');
      // CONTENT_WRITE origin, like content / error writes — a transient upload
      // state must not become an undo entry (#8).
      expect(undo.undoStack.length).toBe(depth);
    });

    it('setNodeHandling writes handlingBy (frontend driver + lease start, #1569)', () => {
      // The fill-from-file path (double-click / Upload menu) must carry the
      // same lease fields as upload-created nodes, or disconnect-cleanup and
      // the lease sweeper cannot reclaim it after a crashed tab.
      addNode(PID, SID, sampleFields('image', {}, { id: 'img2' }));
      const before = Date.now();
      setNodeHandling(PID, SID, 'img2', 'user-x');
      const after = Date.now();
      const node = doc().getMap('nodesMap').get('img2') as Y.Map<unknown>;
      const handlingBy = (node.get('data') as Y.Map<unknown>).get('handlingBy') as {
        userId: string;
        type: string;
        startedAt: number;
      };
      expect(handlingBy.userId).toBe('user-x');
      expect(handlingBy.type).toBe('frontend');
      expect(handlingBy.startedAt).toBeGreaterThanOrEqual(before);
      expect(handlingBy.startedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('drag-stop atomicity — one gesture = one undo entry (#3)', () => {
    /** Read a node's position off the wire node Y.Map. */
    function pos(nodeId: string): { x: number; y: number } | undefined {
      const n = doc().getMap('nodesMap').get(nodeId) as Y.Map<unknown> | undefined;
      return n?.get('position') as { x: number; y: number } | undefined;
    }

    it('a drag-out (move + detach) batched into one transaction is ONE undo entry; undo restores member position AND parent together', () => {
      // m2 is a member of Group g1 (relative position (10,0)); g1 at (0,0).
      addNode(PID, SID, sampleFields('image', {}, { id: 'm2', position: { x: 10, y: 0 }, parentId: 'g1' }));
      addNode(PID, SID, sampleFields('group', { width: 200, height: 200 }, { id: 'g1', position: { x: 0, y: 0 } }));
      const undo = createCanvasUndoManager(doc());
      const depth = undo.undoStack.length;
      // onNodeDragStop dragging m2 out of the Group fires a position write AND a
      // setNodeParent(null) detach — batching makes the gesture ONE atomic undo step.
      runCanvasUndoBatch(PID, SID, () => {
        setNodeParent(PID, SID, 'm2', null, { x: 9999, y: 9999 });
      });
      const m2 = doc().getMap('nodesMap').get('m2') as Y.Map<unknown>;
      expect(m2.get('parentId')).toBeUndefined(); // detached
      expect(undo.undoStack.length).toBe(depth + 1); // one entry, not two
      undo.undo();
      // Undo restored BOTH the parentId AND m2's original (relative) position atomically.
      expect((doc().getMap('nodesMap').get('m2') as Y.Map<unknown>).get('parentId')).toBe('g1');
      expect(pos('m2')).toEqual({ x: 10, y: 0 });
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

  describe('group background — setGroupBackground', () => {
    /** Read a group's backgroundColor off the wire data Y.Map. */
    function bg(groupId: string): unknown {
      const g = doc().getMap('nodesMap').get(groupId) as Y.Map<unknown> | undefined;
      const data = g?.get('data');
      return data instanceof Y.Map ? data.get('backgroundColor') : undefined;
    }

    it('setGroupBackground sets the group backgroundColor', () => {
      addNode(PID, SID, sampleFields('group', {}, { id: 'g1' }));
      setGroupBackground(PID, SID, 'g1', 'var(--color-status-info-bg)');
      expect(bg('g1')).toBe('var(--color-status-info-bg)');
    });

    it('setGroupBackground with undefined clears the color (无色)', () => {
      addNode(
        PID,
        SID,
        sampleFields('group', { backgroundColor: 'x' }, { id: 'g1' }),
      );
      setGroupBackground(PID, SID, 'g1', undefined);
      expect(bg('g1')).toBeUndefined();
    });
  });

  describe('Group mutations (group redesign, parentId model)', () => {
    /** Read a node's top-level parentId straight off the wire. */
    function parentOf(id: string): string | undefined {
      const node = doc().getMap('nodesMap').get(id);
      return node instanceof Y.Map ? (node.get('parentId') as string | undefined) : undefined;
    }
    /** Read a node's position straight off the wire. */
    function posOf(id: string): { x: number; y: number } | undefined {
      const node = doc().getMap('nodesMap').get(id);
      return node instanceof Y.Map
        ? (node.get('position') as { x: number; y: number } | undefined)
        : undefined;
    }
    /** Read a node's data field straight off the wire. */
    function dataOf(id: string, key: string): unknown {
      const node = doc().getMap('nodesMap').get(id);
      if (!(node instanceof Y.Map)) return undefined;
      const data = node.get('data');
      return data instanceof Y.Map ? data.get(key) : undefined;
    }

    it('createGroup stores the Group (width/height) and binds members (parentId + relative position)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'a', position: { x: 100, y: 100 } }));
      addNode(PID, SID, sampleFields('image', {}, { id: 'b', position: { x: 200, y: 180 } }));
      createGroup(
        PID,
        SID,
        sampleFields('group', { width: 240, height: 220 }, { id: 'f', position: { x: 76, y: 76 } }),
        [
          { id: 'a', position: { x: 24, y: 24 } },
          { id: 'b', position: { x: 124, y: 104 } },
        ],
      );
      expect(dataOf('f', 'width')).toBe(240);
      expect(dataOf('f', 'height')).toBe(220);
      expect(parentOf('a')).toBe('f');
      expect(parentOf('b')).toBe('f');
      expect(posOf('a')).toEqual({ x: 24, y: 24 });
      expect(posOf('b')).toEqual({ x: 124, y: 104 });
    });

    it('setNodeParent sets parentId + relative position (join a Group)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'n', position: { x: 300, y: 300 } }));
      setNodeParent(PID, SID, 'n', 'f', { x: 20, y: 30 });
      expect(parentOf('n')).toBe('f');
      expect(posOf('n')).toEqual({ x: 20, y: 30 });
    });

    it('setNodeParent with null clears parentId + sets absolute position (leave a Group)', () => {
      addNode(PID, SID, sampleFields('image', {}, { id: 'n', position: { x: 20, y: 30 }, parentId: 'f' }));
      setNodeParent(PID, SID, 'n', null, { x: 320, y: 330 });
      expect(parentOf('n')).toBeUndefined();
      expect(posOf('n')).toEqual({ x: 320, y: 330 });
    });

    it('resizeGroup writes the Group position + width/height', () => {
      addNode(PID, SID, sampleFields('group', { width: 200, height: 200 }, { id: 'f', position: { x: 0, y: 0 } }));
      resizeGroup(PID, SID, 'f', { x: -10, y: -20 }, 320, 280);
      expect(posOf('f')).toEqual({ x: -10, y: -20 });
      expect(dataOf('f', 'width')).toBe(320);
      expect(dataOf('f', 'height')).toBe(280);
    });

    it('expandGroup grows the Group and reanchors members so their absolute position is preserved', () => {
      addNode(PID, SID, sampleFields('group', { width: 200, height: 200 }, { id: 'f', position: { x: 0, y: 0 } }));
      // member relative (-10,90) → absolute (-10,90); the Group grows left to x=-10.
      addNode(PID, SID, sampleFields('image', {}, { id: 'm', position: { x: -10, y: 90 }, parentId: 'f' }));
      expandGroup(PID, SID, 'f', { x: -10, y: 0 }, 210, 200);
      expect(posOf('f')).toEqual({ x: -10, y: 0 });
      expect(dataOf('f', 'width')).toBe(210);
      // relative shifted by delta (0-(-10)=10, 0): (0,90); absolute = (-10,0)+(0,90) = (-10,90), preserved.
      expect(posOf('m')).toEqual({ x: 0, y: 90 });
    });

    it('expandGroup growing only right/bottom (top-left unchanged) leaves member positions alone', () => {
      addNode(PID, SID, sampleFields('group', { width: 200, height: 200 }, { id: 'f', position: { x: 0, y: 0 } }));
      addNode(PID, SID, sampleFields('image', {}, { id: 'm', position: { x: 150, y: 150 }, parentId: 'f' }));
      expandGroup(PID, SID, 'f', { x: 0, y: 0 }, 250, 250);
      expect(posOf('m')).toEqual({ x: 150, y: 150 });
      expect(dataOf('f', 'width')).toBe(250);
    });

    it('deleting a Group releases its members (clears parentId, restores absolute position, keeps members)', () => {
      addNode(PID, SID, sampleFields('group', { width: 200, height: 200 }, { id: 'f', position: { x: 50, y: 60 } }));
      addNode(PID, SID, sampleFields('image', {}, { id: 'm', position: { x: 10, y: 20 }, parentId: 'f' }));
      removeNode(PID, SID, 'f');
      // member survives, parent cleared, position converted to absolute (rel + group pos)
      expect(doc().getMap('nodesMap').get('f')).toBeUndefined();
      expect(parentOf('m')).toBeUndefined();
      expect(posOf('m')).toEqual({ x: 60, y: 80 });
    });
  });
});

// ── #1580 #7: unified gen lease (owner triple + persistent counter) ──────
//
// Every handling open takes gen = leaseGen + 1 from the node's own counter
// and stamps the owner triple (gen + userId + clientId). Write-backs verify
// the caller still owns the live lease — a superseded upload's late write
// must not clobber the new owner's work.
describe('unified gen lease (#1580 #7)', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('setNodeHandling takes gen = leaseGen + 1, advances leaseGen, stamps the owner triple, and returns the token', () => {
    addNode(PID, SID, sampleFields('image'));
    const lease = setNodeHandling(PID, SID, 'n1', 'user-x');
    expect(lease).toEqual({
      gen: 1,
      clientId: doc().clientID,
      userId: 'user-x',
    });
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    const hb = data.get('handlingBy') as {
      gen: number;
      clientId: number;
      userId: string;
      type: string;
    };
    expect(hb.gen).toBe(1);
    expect(hb.clientId).toBe(doc().clientID);
    expect(hb.userId).toBe('user-x');
    expect(hb.type).toBe('frontend');
    expect(data.get('leaseGen')).toBe(1);
  });

  it('sequential opens increment gen monotonically (leaseGen survives close)', () => {
    addNode(PID, SID, sampleFields('image'));
    const first = setNodeHandling(PID, SID, 'n1', 'user-x');
    completeNodeHandling(PID, SID, 'n1', 'https://cdn/a.png', first!);
    const second = setNodeHandling(PID, SID, 'n1', 'user-x');
    expect(second!.gen).toBe(2);
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('leaseGen')).toBe(2);
  });

  it('setNodeHandling returns undefined for a missing node (no throw)', () => {
    expect(setNodeHandling(PID, SID, 'ghost', 'user-x')).toBeUndefined();
  });

  it('completeNodeHandling with the live token writes content + idle + clears error, returns true', () => {
    addNode(PID, SID, sampleFields('image', { errorMessage: 'old fail' }));
    const lease = setNodeHandling(PID, SID, 'n1', 'user-x');
    const landed = completeNodeHandling(PID, SID, 'n1', 'https://cdn/new.png', lease!);
    expect(landed).toBe(true);
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('content')).toBe('https://cdn/new.png');
    expect(data.get('state')).toBe('idle');
    expect(data.get('errorMessage')).toBeUndefined();
    expect(data.has('handlingBy')).toBe(false);
    // The counter is NEVER cleared — the next open must take gen 2.
    expect(data.get('leaseGen')).toBe(1);
  });

  it('completeNodeHandling with a superseded token is a no-op returning false (owner CAS)', () => {
    addNode(PID, SID, sampleFields('image'));
    const stale = setNodeHandling(PID, SID, 'n1', 'user-a');
    // Another actor re-opened the lease (e.g. after a sweeper reclaim) —
    // the live lease now belongs to gen 2 / user-b.
    const live = setNodeHandling(PID, SID, 'n1', 'user-b');
    const landed = completeNodeHandling(PID, SID, 'n1', 'https://cdn/zombie.png', stale!);
    expect(landed).toBe(false);
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.has('content')).toBe(false);
    expect(data.get('state')).toBe('handling');
    expect((data.get('handlingBy') as { gen: number }).gen).toBe(live!.gen);
  });

  it('completeNodeHandling with a different clientId same gen is rejected (two tabs racing the same gen)', () => {
    addNode(PID, SID, sampleFields('image'));
    const lease = setNodeHandling(PID, SID, 'n1', 'user-a');
    const foreign = { ...lease!, clientId: lease!.clientId + 1 };
    expect(completeNodeHandling(PID, SID, 'n1', 'https://cdn/x.png', foreign)).toBe(false);
  });

  it('failNodeHandling with a superseded token is a no-op returning false', () => {
    addNode(PID, SID, sampleFields('image'));
    const stale = setNodeHandling(PID, SID, 'n1', 'user-a');
    setNodeHandling(PID, SID, 'n1', 'user-b');
    expect(failNodeHandling(PID, SID, 'n1', 'boom', stale!)).toBe(false);
    const data = (doc().getMap('nodesMap').get('n1') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(data.get('state')).toBe('handling');
    expect(data.has('errorMessage')).toBe(false);
  });

  it('isNodeHandling reflects the node state (busy gate primitive)', () => {
    addNode(PID, SID, sampleFields('image'));
    expect(isNodeHandling(PID, SID, 'n1')).toBe(false);
    setNodeHandling(PID, SID, 'n1', 'user-x');
    expect(isNodeHandling(PID, SID, 'n1')).toBe(true);
    expect(isNodeHandling(PID, SID, 'ghost')).toBe(false);
  });
});
