// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  runMediaUploadBatch: vi.fn().mockResolvedValue(undefined),
}));

import { runMediaUploadBatch } from '@web/data/upload/media-upload';
import { fillNodesFromFiles, type FillNodesDeps } from '@web/spaces/canvas/canvas-upload';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/**
 * A node's upload mark in the Space these tests fill.
 * @param nodeId - The node.
 * @returns Its mark.
 */
const markOf = (nodeId: string) => useUploadMarksStore.getState().markOf('s1', nodeId);

const TAG = { source: 'mini_tool', toolName: 'image.grid' } as const;

/**
 * Tiles for `count` nodes, each carrying the grid run's own operation, begun
 * the way the tool begins it.
 * @param count - How many.
 * @returns One entry per node.
 */
function tiles(count: number): { nodeId: string; file: File; markOp: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    nodeId: `node-${i}`,
    file: new File([new Uint8Array(2)], `GRID-${i}.png`, { type: 'image/png' }),
    markOp: useUploadMarksStore.getState().begin('s1', `node-${i}`, 'image.grid'),
  }));
}

/**
 * Deps with spies.
 * @param locked - The nodes that read as locked.
 * @returns The deps.
 */
function deps(locked: readonly string[] = []): FillNodesDeps {
  return {
    getUploadConfig: vi.fn(),
    hashFile: vi.fn(),
    requestTicketBatch: vi.fn(),
    sendToIngest: vi.fn(),
    spaceId: 's1',
    tag: TAG,
    isLocked: (nodeId) => locked.includes(nodeId),
    onLocked: vi.fn(),
    track: vi.fn(),
    onUploadFailure: vi.fn(),
  };
}

describe('fillNodesFromFiles', () => {
  it('uploads every tile in one batch and registers each node as busy', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    const d = deps();

    fillNodesFromFiles(tiles(64), 'p1', d);

    expect(runMediaUploadBatch).toHaveBeenCalledTimes(1);
    const [entries, context] = vi.mocked(runMediaUploadBatch).mock.calls[0]!;
    expect(entries.map((e) => e.nodeId)).toEqual(tiles(64).map((t) => t.nodeId));
    expect(context).toEqual({ projectId: 'p1', spaceId: 's1', ...TAG });
    expect(vi.mocked(d.track).mock.calls.map(([nodeId]) => nodeId)).toEqual(tiles(64).map((t) => t.nodeId));
  });

  // inner#1303 §6.7: the tool's operation runs on to the answer, so the
  // collaborators keep seeing the tool (§6.8).
  it('carries on the operation each tile was handed, and clears each on its own answer', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    useUploadMarksStore.setState({ marks: {} });
    const handed = tiles(2);
    fillNodesFromFiles(handed, 'p1', deps());
    expect(markOf('node-0')).toEqual({ op: handed[0]!.markOp, action: 'image.grid', at: expect.any(Number), state: 'waiting' });
    expect(markOf('node-1')?.state).toBe('waiting');
    const [entries] = vi.mocked(runMediaUploadBatch).mock.calls[0]!;
    entries[0]!.onAnswered!();
    expect([markOf('node-0'), markOf('node-1')?.state]).toEqual([undefined, 'waiting']);
  });

  it('says a failure before the answer on the tile itself', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    useUploadMarksStore.setState({ marks: {} });
    const d = deps();
    fillNodesFromFiles(tiles(2), 'p1', d);
    const [entries] = vi.mocked(runMediaUploadBatch).mock.calls[0]!;
    entries[1]!.onFailure({ reason: 'storage' });
    expect(markOf('node-1')).toMatchObject({ state: 'failed', message: { key: 'canvas.upload.storageFull' } });
    expect(d.onUploadFailure).not.toHaveBeenCalled();
  });

  it('hands a failure after the answer to the caller with its own file', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    const d = deps();
    const files = tiles(2);

    fillNodesFromFiles(files, 'p1', d);
    const [entries] = vi.mocked(runMediaUploadBatch).mock.calls[0]!;
    entries[1]!.onAnswered!();
    entries[1]!.onFailure({ reason: 'transfer', taskId: 'row-1' });

    expect(d.onUploadFailure).toHaveBeenCalledWith({ reason: 'transfer', taskId: 'row-1' }, files[1]!.file);
  });

  it('leaves a locked node out and says so once', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    const d = deps(['node-1', 'node-2']);

    fillNodesFromFiles(tiles(3), 'p1', d);

    const [entries] = vi.mocked(runMediaUploadBatch).mock.calls[0]!;
    expect(entries.map((e) => e.nodeId)).toEqual(['node-0']);
    expect(d.onLocked).toHaveBeenCalledTimes(1);
  });

  it('ends the operation of a node it leaves out for being locked', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    useUploadMarksStore.setState({ marks: {} });
    fillNodesFromFiles(tiles(2), 'p1', deps(['node-1']));
    expect([markOf('node-0')?.state, markOf('node-1')]).toEqual(['waiting', undefined]);
  });

  // inner#1595 §3.4–§3.5: the server could not open one tile's upload at the
  // ingest Worker. Every tile's wait ends on its answer; only that tile fails,
  // handed to the caller with its own File, and only the others are sent.
  it('W14 one tile answered openFailed: every mark clears, only it fails, the others are sent', async () => {
    const actual = await vi.importActual<typeof import('@web/data/upload/media-upload')>(
      '@web/data/upload/media-upload',
    );
    vi.mocked(runMediaUploadBatch).mockClear().mockImplementationOnce(actual.runMediaUploadBatch);
    useUploadMarksStore.setState({ marks: {} });
    const handed = tiles(3);
    /**
     * A ticket for one tile in the new shape.
     * @param i - The tile.
     * @returns The ticket.
     */
    const ticketFor = (i: number): Record<string, unknown> => ({
      uploadId: `upload-${i}`,
      token: `token-${i}`,
      storageKey: `image/k${i}.png`,
      uploadUrl: 'https://ingest.example.com',
      kind: 'image',
      partSize: 5 * 1024 * 1024,
      totalParts: 1,
      taskId: `task-${i}`,
    });
    let work: Promise<void> | undefined;
    const d: FillNodesDeps = {
      ...deps(),
      getUploadConfig: vi.fn().mockResolvedValue({
        maxUploadBytes: 2147483648,
        clientMaxAttempts: 3,
        clientRetryBaseDelayMs: 1000,
        uploadIdleTimeoutMs: 60000,
      }),
      hashFile: vi.fn().mockResolvedValue('a'.repeat(64)),
      requestTicketBatch: vi.fn().mockResolvedValue([
        ticketFor(0),
        { openFailed: { reason: 'store_failed' }, taskId: 't2' },
        ticketFor(2),
      ]),
      sendToIngest: vi.fn().mockImplementation(async (_file: File, t: { storageKey: string }) => ({
        storageKey: t.storageKey,
      })),
      // A node's ending arrives through Yjs; these tests stop at the send.
      waitForEnding: vi.fn(() => new Promise<never>(() => undefined)),
      track: vi.fn((_nodeId: string, w: Promise<void>) => {
        work = w;
      }),
      sleep: () => Promise.resolve(),
    };

    fillNodesFromFiles(handed, 'p1', d);
    await work;

    expect(handed.map((t) => markOf(t.nodeId))).toEqual([undefined, undefined, undefined]);
    expect(d.onUploadFailure).toHaveBeenCalledExactlyOnceWith({ reason: 'transfer', taskId: 't2' }, handed[1]!.file);
    const sent = vi.mocked(d.sendToIngest).mock.calls.map(([file]) => file);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(handed[0]!.file);
    expect(sent[1]).toBe(handed[2]!.file);
  });
});
