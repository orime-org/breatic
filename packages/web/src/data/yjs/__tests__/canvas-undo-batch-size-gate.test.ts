// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 5 (W-51 to W-53): one
 * `runCanvasUndoBatch` is judged once, as a whole, with the kind and estimate
 * its caller declares; the writes inside it are not judged again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type CanvasNodeFields } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import {
  addEdge,
  addNode,
  getCanvasUndoManager,
  removeEdge,
  removeNode,
  runCanvasUndoBatch,
  setNodeName,
  setNodeParent,
  setNodePosition,
  readEdges,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { estimateNodeBytes, reserveSpaceRoom } from '@web/data/yjs/space-write';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import { COPY_EN, F_FULL, F_FULL_NEAR, F_WARNING, type DocSizePush } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p1';
const SID = 's1';
const NAME = docName.canvasSpace(PID, SID);

/**
 * Wire fields of a plain node.
 * @param id - Node id.
 * @param type - Node modality.
 * @returns The node.
 */
function node(id: string, type = 'image'): CanvasNodeFields {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  } as CanvasNodeFields;
}

const N9 = node('n9');

/**
 * Seeds t1, g1 (a group) and the edge t1->g1 while the size is unknown, then
 * delivers one push.
 * @param push - The size push.
 * @returns The canvas document.
 * @throws {Error} When seeding fails.
 */
function boardAt(push: DocSizePush): Y.Doc {
  const { doc, provider } = openSizedDoc(NAME);
  addNode(PID, SID, node('t1', 'text'));
  addNode(PID, SID, { ...node('g1', 'group'), data: { ...node('g1', 'group').data, width: 400, height: 300 } } as CanvasNodeFields);
  addEdge(PID, SID, { id: 't1->g1', source: 't1', target: 'g1' });
  pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
  return doc;
}

/**
 * The add batch section 5 uses: a node, an edge to it, and its name.
 * @returns Nothing.
 */
function addBatch(): void {
  addNode(PID, SID, N9);
  addEdge(PID, SID, { id: 't1->n9', source: 't1', target: 'n9' });
  setNodeName(PID, SID, 'n9', 'x');
}

/**
 * The name of n9, or undefined while it does not exist.
 * @param doc - Canvas document.
 * @returns Its name.
 */
function n9Name(doc: Y.Doc): unknown {
  return (doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get('n9')?.get('data') as Y.Map<unknown> | undefined)?.get('name');
}

beforeEach(() => {
  sizeGateProviders.length = 0;
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.clearAllMocks();
});

describe('W-51 a refused batch runs nothing, leaves no undo step and warns once', () => {
  it('refuses the whole add batch at full', () => {
    const doc = boardAt(F_FULL);
    const undo = getCanvasUndoManager(doc, NAME);
    const depth = undo.undoStack.length;
    const before = Y.encodeStateAsUpdate(doc);
    const fn = vi.fn(addBatch);
    expect(runCanvasUndoBatch(PID, SID, { kind: 'add', estimate: 1 }, fn)).toEqual({ ok: false, reason: 'full' });
    expect(fn).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(undo.undoStack.length).toBe(depth);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-52 an allowed batch is not judged again write by write', () => {
  const E = estimateNodeBytes(N9);

  it('lands the whole batch near full', () => {
    const doc = boardAt(F_WARNING);
    const undo = getCanvasUndoManager(doc, NAME);
    const depth = undo.undoStack.length;
    expect(runCanvasUndoBatch(PID, SID, { kind: 'add', estimate: E }, addBatch)).toEqual({ ok: true });
    expect(doc.getMap(CANVAS_NODES_KEY).has('n9')).toBe(true);
    expect(readEdges(doc).some((e) => e.id === 't1->n9')).toBe(true);
    expect(n9Name(doc)).toBe('x');
    expect(undo.undoStack.length).toBe(depth + 1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('lands the whole batch when its estimate equals the room, recording one reservation only', () => {
    const doc = boardAt({ ...F_WARNING, room: E });
    const undo = getCanvasUndoManager(doc, NAME);
    const depth = undo.undoStack.length;
    expect(runCanvasUndoBatch(PID, SID, { kind: 'add', estimate: E }, addBatch)).toEqual({ ok: true });
    expect(doc.getMap(CANVAS_NODES_KEY).has('n9')).toBe(true);
    expect(readEdges(doc).some((e) => e.id === 't1->n9')).toBe(true);
    expect(n9Name(doc)).toBe('x');
    expect(undo.undoStack.length).toBe(depth + 1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(reserveSpaceRoom(NAME, 1, { notify: false })).toEqual({ ok: false, reason: 'no_room', room: 0 });
  });

  it('refuses the batch when one byte is missing', () => {
    const doc = boardAt({ ...F_WARNING, room: E - 1 });
    const before = Y.encodeStateAsUpdate(doc);
    expect(runCanvasUndoBatch(PID, SID, { kind: 'add', estimate: E }, addBatch)).toEqual({ ok: false, reason: 'no_room', room: E - 1 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap(CANVAS_NODES_KEY).has('n9')).toBe(false);
  });
});

describe('W-53 a batch is judged by its strongest kind', () => {
  it('(a) overwrite plus delete is refused once the overwrite room is gone', () => {
    const doc = boardAt(F_FULL_NEAR);
    const before = Y.encodeStateAsUpdate(doc);
    const result = runCanvasUndoBatch(PID, SID, { kind: 'overwrite' }, () => {
      setNodePosition(PID, SID, 't1', { x: 50, y: 50 }, null);
      removeEdge(PID, SID, 't1->g1');
    });
    expect(result).toEqual({ ok: false, reason: 'full' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readEdges(doc).some((e) => e.id === 't1->g1')).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_OVERWRITE_BLOCKED);
  });

  it('(b) a delete-only batch goes through at the same size', () => {
    const doc = boardAt(F_FULL_NEAR);
    const result = runCanvasUndoBatch(PID, SID, { kind: 'delete' }, () => {
      removeEdge(PID, SID, 't1->g1');
      removeNode(PID, SID, 't1');
    });
    expect(result).toEqual({ ok: true });
    expect(readEdges(doc).some((e) => e.id === 't1->g1')).toBe(false);
    expect(doc.getMap(CANVAS_NODES_KEY).has('t1')).toBe(false);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('(c) overwrite plus add is refused at full as an add', () => {
    const doc = boardAt(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    const result = runCanvasUndoBatch(PID, SID, { kind: 'add', estimate: 1 }, () => {
      setNodeParent(PID, SID, 't1', 'g1', { x: 10, y: 10 });
      addEdge(PID, SID, { id: 'g1->t1', source: 'g1', target: 't1' });
    });
    expect(result).toEqual({ ok: false, reason: 'full' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
  });
});
