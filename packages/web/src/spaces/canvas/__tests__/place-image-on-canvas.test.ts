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

  it('does not upload, clears the mark and lets go when the document was rebuilt before its receipt', async () => {
    const pending = placeImageOnCanvas(REQUEST);
    sync();
    await expect(pending).resolves.toMatchObject({ status: 'placed' });
    const nodeId = readNodePlacements('p1', 'c1')[0]?.id;
    confirm('gone');
    await vi.waitFor(() => expect(h.released).toHaveLength(1));
    expect(h.uploadIntoNode).not.toHaveBeenCalled();
    expect(markOf(nodeId)).toBeUndefined();
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
