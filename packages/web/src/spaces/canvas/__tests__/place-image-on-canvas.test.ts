// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Placing a captured image on a canvas that may not be open (#1411 design
 * 5.3): connect, wait for the sync and write an empty image node with its
 * upload mark, which hands the image over; then, in the background, wait for
 * collab to confirm the node and upload into it, holding the document
 * throughout and the leave guard until the bytes are on their way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';

type Listener = () => void;
const h = vi.hoisted(() => ({
  synced: false,
  syncedListeners: [] as Array<() => void>,
  receipt: 'pending' as 'pending' | 'confirmed' | 'gone',
  syncListeners: [] as Array<() => void>,
  acquired: [] as Array<{ name: string; doc: unknown }>,
  released: [] as Array<{ name: string; doc: unknown }>,
  uploadIntoNode: vi.fn(),
  failCreate: false,
}));
vi.mock('@web/data/yjs/collab-socket', async (importOriginal) => ({
  ...await importOriginal<typeof import('@web/data/yjs/collab-socket')>(),
  acquireDocProvider: (name: string, doc: unknown) => {
    h.acquired.push({ name, doc });
    return { on: (event: string, cb: Listener) => { if (event === 'synced') h.syncedListeners.push(cb); }, off: () => undefined, get synced() { return h.synced; } };
  },
  readDocFacts: () => ({ hasEverSynced: h.synced, authFailure: null, sessionEnded: false }),
  releaseDocProvider: (name: string, doc: unknown) => { h.released.push({ name, doc }); },
  hasDocUnsyncedEdits: () => h.receipt,
  subscribeProjectSync: (_projectId: string, listener: Listener) => { h.syncListeners.push(listener); return () => { h.syncListeners.splice(h.syncListeners.indexOf(listener), 1); }; },
}));
vi.mock('@web/spaces/canvas/upload-into-node', () => ({ uploadIntoNode: h.uploadIntoNode }));
vi.mock('@web/spaces/canvas/node-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/canvas/node-factory')>();
  return { ...actual, createEmptyNode: (...args: Parameters<typeof actual.createEmptyNode>) => {
    if (h.failCreate) throw new Error('create failed');
    return actual.createEmptyNode(...args);
  } };
});

import { clearAllDocSizes, setDocSize } from '@web/data/yjs/doc-size';
import { P_FULL } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { readNodePlacements } from '@web/data/yjs/canvas-space';
import { placeImageOnCanvas } from '@web/spaces/canvas/place-image-on-canvas';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const NAME = docName.canvasSpace('p1', 'c1');
const FILE = new File(['png'], '3D-Room.png', { type: 'image/png' });
const REQUEST = { projectId: 'p1', spaceId: 'c1', file: FILE, size: { width: 2048, height: 1152 }, userId: 'u1', origin: { x: 100, y: 100 }, syncTimeoutMs: 1000 };
const busy = (): boolean => useSpaceOperationsStore.getState().hasOperations('c1');
const markOf = (nodeId: string | undefined) => (nodeId === undefined ? undefined : useUploadMarksStore.getState().markOf('c1', nodeId));

/** Let the provider finish its handshake. */
function sync(): void { h.synced = true; h.syncedListeners.splice(0).forEach((cb) => cb()); }
/** Collab answers the write's receipt. */
function confirm(state: 'confirmed' | 'gone' = 'confirmed'): void { h.receipt = state; h.syncListeners.slice().forEach((cb) => cb()); }

beforeEach(() => {
  h.synced = false; h.syncedListeners.length = 0; h.receipt = 'pending'; h.syncListeners.length = 0;
  h.acquired.length = 0; h.released.length = 0;
  h.uploadIntoNode.mockReset().mockResolvedValue(undefined);
  useUploadMarksStore.setState({ marks: {} });
  useSpaceOperationsStore.setState({ operations: {} });
  h.failCreate = false;
  clearAllDocSizes();
});
afterEach(() => { vi.useRealTimers(); _resetForTests(); });

describe('placeImageOnCanvas', () => {
  it('hands over once the empty image node is written, with its upload mark already on it', async () => {
    const pending = placeImageOnCanvas(REQUEST);
    expect(busy()).toBe(true);
    expect(h.acquired).toEqual([{ name: NAME, doc: getDoc(NAME) }]);
    sync();
    const outcome = await pending;
    const nodeId = readNodePlacements('p1', 'c1')[0]?.id;
    expect(outcome).toEqual({ status: 'placed', nodeId });
    const node = getDoc(NAME).getMap<Y.Map<unknown>>('nodesMap').values().next().value;
    expect(node?.get('type')).toBe('image');
    const data = node?.get('data') as Y.Map<unknown> | undefined;
    expect(data?.get('mediaWidth')).toBe(2048);
    expect(data?.get('mediaHeight')).toBe(1152);
    expect(markOf(nodeId)?.state).toBe('waiting');
    // The receipt has not come: nothing is uploaded or released yet, and the canvas still counts as busy.
    expect(h.uploadIntoNode).not.toHaveBeenCalled();
    expect(h.released).toEqual([]);
    expect(busy()).toBe(true);
  });

  it('uploads in the background after the receipt, continuing the mark, and releases the same document last', async () => {
    let finish = (): void => undefined;
    h.uploadIntoNode.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const pending = placeImageOnCanvas(REQUEST);
    sync();
    await pending;
    const nodeId = readNodePlacements('p1', 'c1')[0]?.id;
    const op = markOf(nodeId)?.op;
    confirm();
    await vi.waitFor(() => expect(h.uploadIntoNode).toHaveBeenCalledWith({ projectId: 'p1', spaceId: 'c1', nodeId }, FILE, { continuing: op }));
    expect(busy()).toBe(false);
    expect(h.released).toEqual([]);
    finish();
    await vi.waitFor(() => expect(h.released).toEqual([{ name: NAME, doc: h.acquired[0]?.doc }]));
  });

  it('gives up without writing when the canvas does not sync in time', async () => {
    vi.useFakeTimers();
    const pending = placeImageOnCanvas(REQUEST);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ status: 'unreachable' });
    expect(readNodePlacements('p1', 'c1')).toHaveLength(0);
    expect(h.released).toHaveLength(1);
    expect(busy()).toBe(false);
  });

  it('does not upload, says the Space is full on the node and lets go when the document was rebuilt before its receipt', async () => {
    const pending = placeImageOnCanvas(REQUEST);
    sync();
    await expect(pending).resolves.toMatchObject({ status: 'placed' });
    const nodeId = readNodePlacements('p1', 'c1')[0]?.id;
    confirm('gone');
    await vi.waitFor(() => expect(h.released).toHaveLength(1));
    expect(h.uploadIntoNode).not.toHaveBeenCalled();
    // A rebuilt document may still hold the node collab already took; it then says why it stayed empty.
    expect(markOf(nodeId)).toMatchObject({ state: 'failed', message: { key: 'spaces.sizeCap.reason' } });
    expect(busy()).toBe(false);
  });

  it('writes nothing, leaves no mark and lets go when the size gate refuses the node', async () => {
    setDocSize(NAME, { type: 'doc:size', seq: 1, ...P_FULL });
    const pending = placeImageOnCanvas(REQUEST);
    sync();
    await expect(pending).resolves.toEqual({ status: 'refused' });
    expect(readNodePlacements('p1', 'c1')).toHaveLength(0);
    expect(useUploadMarksStore.getState().marks).toEqual({});
    expect(h.released).toEqual([{ name: NAME, doc: h.acquired[0]?.doc }]);
    expect(busy()).toBe(false);
  });

  it('lets go of the document and the leave guard when writing the node throws', async () => {
    h.failCreate = true;
    const pending = placeImageOnCanvas(REQUEST);
    sync();
    await expect(pending).rejects.toThrow('create failed');
    expect(h.released).toHaveLength(1);
    expect(busy()).toBe(false);
  });

  it('marks the node failed and lets go when the background upload throws', async () => {
    h.uploadIntoNode.mockImplementation(() => { throw new Error('upload threw'); });
    const pending = placeImageOnCanvas(REQUEST);
    sync();
    await pending;
    const nodeId = readNodePlacements('p1', 'c1')[0]?.id;
    confirm();
    await vi.waitFor(() => expect(h.released).toHaveLength(1));
    expect(markOf(nodeId)?.state).toBe('failed');
    expect(busy()).toBe(false);
  });

  it('steps past a node already at the origin', async () => {
    h.synced = true;
    await placeImageOnCanvas(REQUEST);
    await placeImageOnCanvas(REQUEST);
    const [a, b] = readNodePlacements('p1', 'c1');
    expect(a && b && (a.x !== b.x || a.y !== b.y)).toBe(true);
  });
});
