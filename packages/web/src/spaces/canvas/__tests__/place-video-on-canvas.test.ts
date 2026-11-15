// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Putting an exported video on a canvas whose tab may be closed (#1490 design §9.1), through the placement the 3D
 * viewfinder's picture already takes: connect, wait for the first sync, write a video node beside what is at the
 * origin, wait for collab's receipt, let go. The node carries the registered video, its cover, length, size, type and
 * byte size, and the link back to the Motion result; nothing is uploaded, because the video is already an asset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const socket = vi.hoisted(() => ({
  synced: true,
  receipt: 'confirmed' as 'pending' | 'confirmed' | 'gone',
  listeners: new Set<() => void>(),
  acquired: 0,
  released: 0,
}));

vi.mock('@web/data/yjs/collab-socket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/yjs/collab-socket')>()),
  acquireDocProvider: () => { socket.acquired += 1; return { on: vi.fn(), off: vi.fn() }; },
  releaseDocProvider: () => { socket.released += 1; },
  readDocFacts: () => ({ hasEverSynced: socket.synced, authFailure: null }),
  hasDocUnsyncedEdits: () => socket.receipt,
  subscribeProjectSync: (_projectId: string, listener: () => void) => { socket.listeners.add(listener); return () => socket.listeners.delete(listener); },
}));

import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';
import { placeVideoOnCanvas } from '@web/spaces/canvas/place-video-on-canvas';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

const PROJECT = 'p1';
const CANVAS = 'c1';
const NAME = docName.canvasSpace(PROJECT, CANVAS);
const VIDEO = {
  content: 'https://cdn.example/v.mp4', coverUrl: 'https://cdn.example/v_cover.png', duration: 6,
  mediaWidth: 1080, mediaHeight: 1920, mimeType: 'video/mp4', size: 4_000_000,
  sourceAnimation: { spaceId: 's1', executionId: 'e1', videoUrl: 'https://cdn.example/v.mp4' },
};

/**
 * Place the video once.
 * @returns How it went.
 */
function place(): ReturnType<typeof placeVideoOnCanvas> {
  return placeVideoOnCanvas({ projectId: PROJECT, spaceId: CANVAS, video: VIDEO, userId: 'u1', origin: { x: 100, y: 200 }, syncTimeoutMs: 50 });
}

/**
 * The stored data of a node.
 * @param nodeId - The node.
 * @returns Its type and data.
 */
function stored(nodeId: string): { type: unknown; data: Record<string, unknown> } {
  const entry = getDoc(NAME).getMap<Y.Map<unknown>>('nodesMap').get(nodeId);
  return { type: entry?.get('type'), data: (entry?.get('data') as Y.Map<unknown> | undefined)?.toJSON() ?? {} };
}

beforeEach(() => {
  _resetForTests();
  Object.assign(socket, { synced: true, receipt: 'confirmed', acquired: 0, released: 0 });
  socket.listeners.clear();
  useSpaceOperationsStore.setState({ operations: {} });
});

afterEach(() => {
  clearAllDocSizes();
  _resetForTests();
});

describe('placeVideoOnCanvas', () => {
  it('writes a video node carrying the asset and its source animation, and lets the canvas go once collab confirms', async () => {
    const outcome = await place();
    expect(outcome).toEqual({ status: 'placed', nodeId: expect.any(String) });
    if (outcome.status !== 'placed') return;
    expect(stored(outcome.nodeId)).toEqual({ type: 'video', data: expect.objectContaining(VIDEO) });
    await vi.waitFor(() => expect(socket.released).toBe(socket.acquired));
    expect(useSpaceOperationsStore.getState().hasOperations(CANVAS)).toBe(false);
  });

  it('holds the canvas and the leave guard until the receipt arrives', async () => {
    socket.receipt = 'pending';
    const outcome = await place();
    expect(outcome.status).toBe('placed');
    expect(useSpaceOperationsStore.getState().hasOperations(CANVAS)).toBe(true);
    expect(socket.released).toBe(0);
    socket.receipt = 'confirmed';
    for (const listener of socket.listeners) listener();
    await vi.waitFor(() => expect(socket.released).toBe(1));
    expect(useSpaceOperationsStore.getState().hasOperations(CANVAS)).toBe(false);
  });

  it('writes nothing and lets go when the canvas does not sync in time', async () => {
    socket.synced = false;
    expect(await place()).toEqual({ status: 'unreachable' });
    expect(getDoc(NAME).getMap('nodesMap').size).toBe(0);
    expect(socket.released).toBe(1);
    expect(useSpaceOperationsStore.getState().hasOperations(CANVAS)).toBe(false);
  });

  it('writes nothing when the size gate refuses the node', async () => {
    enterSize(NAME, 'F');
    expect(await place()).toEqual({ status: 'refused' });
    expect(getDoc(NAME).getMap('nodesMap').size).toBe(0);
    expect(socket.released).toBe(1);
  });
});
