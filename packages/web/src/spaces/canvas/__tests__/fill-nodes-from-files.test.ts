// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  runMediaUploadBatch: vi.fn().mockResolvedValue(undefined),
}));

import { runMediaUploadBatch } from '@web/data/upload/media-upload';
import { fillNodesFromFiles, type FillNodesDeps } from '@web/spaces/canvas/canvas-upload';

const TAG = { source: 'mini_tool', toolName: 'image.grid' } as const;

/**
 * Tiles for `count` nodes.
 * @param count - How many.
 * @returns One entry per node.
 */
function tiles(count: number): { nodeId: string; file: File }[] {
  return Array.from({ length: count }, (_, i) => ({
    nodeId: `node-${i}`,
    file: new File([new Uint8Array(2)], `GRID-${i}.png`, { type: 'image/png' }),
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

  it('hands a tile’s failure to the caller with its own file', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    const d = deps();
    const files = tiles(2);

    fillNodesFromFiles(files, 'p1', d);
    const [entries] = vi.mocked(runMediaUploadBatch).mock.calls[0]!;
    entries[1]!.onFailure({ reason: 'storage' });

    expect(d.onUploadFailure).toHaveBeenCalledWith({ reason: 'storage' }, files[1]!.file);
  });

  it('leaves a locked node out and says so once', () => {
    vi.mocked(runMediaUploadBatch).mockClear();
    const d = deps(['node-1', 'node-2']);

    fillNodesFromFiles(tiles(3), 'p1', d);

    const [entries] = vi.mocked(runMediaUploadBatch).mock.calls[0]!;
    expect(entries.map((e) => e.nodeId)).toEqual(['node-0']);
    expect(d.onLocked).toHaveBeenCalledTimes(1);
  });
});
