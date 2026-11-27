// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Building a node and wiring its upstreams in one step (inner#2216 design
 * 4.4), against a real canvas document: one undo takes the node and every
 * wire back, and the new node's reference list reads in the order the wires
 * were handed in, even when every wire is written in the same millisecond.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type { CanvasNodeFields } from '@breatic/shared';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  getCanvasUndoManager,
  readEdges,
  readNodes,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { createConnectedNode } from '@web/spaces/canvas/create-connected-node';

const PID = 'p';
const SID = 's';
const NAME = docName.canvasSpace(PID, SID);
const NEW_ID = 'new-node';

/**
 * Seeds one content node into the canvas document.
 * @param id - The node id.
 * @param type - Its modality.
 * @param y - Its y position.
 */
function seed(id: string, type: string, y = 0): void {
  addNode(PID, SID, {
    id,
    type,
    position: { x: 0, y },
    data: { name: id, createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  } as CanvasNodeFields);
}

/**
 * The canvas's node builder as the test hands it in: writes an empty node
 * centred on the point and returns its id.
 * @param type - The modality to build.
 * @param center - The centre in flow coordinates.
 * @returns The new node's id.
 */
function createNodeAt(type: CreatableNodeType, center: { x: number; y: number }): string {
  addNode(PID, SID, {
    id: NEW_ID,
    type,
    position: { x: center.x - 144, y: center.y - 96 },
    data: { name: 'new', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  } as CanvasNodeFields);
  return NEW_ID;
}

/**
 * The source ids of the new node's reference list, as the rail reads it.
 * @returns The ids in rail order.
 */
function railOfNewNode(): string[] {
  const doc = getDoc(NAME);
  return deriveReferences(NEW_ID, readNodes(doc), readEdges(doc), new Map()).map((row) => row.sourceNodeId);
}

beforeEach(() => {
  _resetForTests();
  _resetCanvasUndoCacheForTests();
});

afterEach(() => {
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
});

describe('createConnectedNode', () => {
  it('writes one wire per source with ids source->node and createdAt rising by one from now()', () => {
    seed('z-img', 'image', 0);
    seed('a-text', 'text', 300);
    const result = createConnectedNode({
      projectId: PID,
      spaceId: SID,
      type: 'video',
      center: { x: 600, y: 200 },
      sourceIds: ['z-img', 'a-text'],
      createNodeAt,
      now: () => 5000,
    });
    expect(result).toEqual({ nodeId: NEW_ID, failedSourceIds: [] });
    const wires = readEdges(getDoc(NAME))
      .filter((e) => e.target === NEW_ID)
      .map((e) => ({ id: e.id, source: e.source, createdAt: e.createdAt }))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    expect(wires).toEqual([
      { id: `z-img->${NEW_ID}`, source: 'z-img', createdAt: 5000 },
      { id: `a-text->${NEW_ID}`, source: 'a-text', createdAt: 5001 },
    ]);
  });

  it('stamps from Date.now() when no clock is passed', () => {
    seed('a', 'image');
    vi.spyOn(Date, 'now').mockReturnValue(7000);
    createConnectedNode({ projectId: PID, spaceId: SID, type: 'image', center: { x: 0, y: 0 }, sourceIds: ['a'], createNodeAt });
    const wire = readEdges(getDoc(NAME)).find((e) => e.target === NEW_ID);
    expect(wire?.createdAt).toBe(7000);
  });

  it('lists the references in the order given even when every wire shares one millisecond', () => {
    // Ids sort the other way round, so the edge-id tiebreak alone would
    // read m, a, z reversed; only the rising stamps keep the given order.
    seed('z-img', 'image', 0);
    seed('m-img', 'image', 300);
    seed('a-text', 'text', 600);
    createConnectedNode({
      projectId: PID,
      spaceId: SID,
      type: 'image',
      center: { x: 600, y: 300 },
      sourceIds: ['z-img', 'm-img', 'a-text'],
      createNodeAt,
      now: () => 1000,
    });
    expect(railOfNewNode()).toEqual(['z-img', 'm-img', 'a-text']);
  });

  it('is one undo step: a single undo removes the node and every wire', () => {
    seed('a', 'image', 0);
    seed('b', 'text', 300);
    const doc = getDoc(NAME);
    const undo = getCanvasUndoManager(doc, NAME);
    const before = undo.undoStack.length;
    createConnectedNode({ projectId: PID, spaceId: SID, type: 'video', center: { x: 600, y: 200 }, sourceIds: ['a', 'b'], createNodeAt, now: () => 1 });
    expect(undo.undoStack.length).toBe(before + 1);
    expect(readNodes(doc).map((n) => n.id)).toContain(NEW_ID);
    expect(readEdges(doc).filter((e) => e.target === NEW_ID)).toHaveLength(2);

    undo.undo();

    expect(readNodes(doc).map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(readEdges(doc)).toEqual([]);
  });

  it('reports a source that no longer exists and still wires the rest', () => {
    seed('a', 'image');
    const result = createConnectedNode({
      projectId: PID,
      spaceId: SID,
      type: 'image',
      center: { x: 600, y: 0 },
      sourceIds: ['a', 'gone'],
      createNodeAt,
      now: () => 1,
    });
    expect(result).toEqual({ nodeId: NEW_ID, failedSourceIds: ['gone'] });
    expect(readEdges(getDoc(NAME)).map((e) => e.id)).toEqual([`a->${NEW_ID}`]);
  });

  // Critical path (Yjs canvas write): for any set of upstreams in any order
  // and any one-millisecond clock, the rail reads the given order and one
  // undo leaves the document as it was before the build.
  it('keeps the given order and undoes in one step for any sources', () => {
    const pool = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f', 's-g'];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(pool, { minLength: 1 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        (sourceIds, stamp) => {
          _resetForTests();
          _resetCanvasUndoCacheForTests();
          pool.forEach((id, i) => seed(id, i % 2 === 0 ? 'image' : 'text', i * 300));
          const doc = getDoc(NAME);
          const undo = getCanvasUndoManager(doc, NAME);
          const result = createConnectedNode({ projectId: PID, spaceId: SID, type: 'video', center: { x: 900, y: 0 }, sourceIds, createNodeAt, now: () => stamp });
          expect(result).toEqual({ nodeId: NEW_ID, failedSourceIds: [] });
          expect(railOfNewNode()).toEqual(sourceIds);
          undo.undo();
          expect(readNodes(doc).map((n) => n.id).sort()).toEqual([...pool].sort());
          expect(readEdges(doc)).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });
});
