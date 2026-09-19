// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one press of Understand does (#2175).
 *
 * The order is the point. Two questions the browser can answer for itself
 * come first, and a no to either is a toast and nothing else — no node, no
 * edge, no request, because there is no run for the refusal to land on. Past
 * those the node and its edge are written in one undo step and the request
 * goes out; from there the run owns whatever happens, and it says so on the
 * row beside the node it just built.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/yjs/canvas-space', () => ({
  addNode: vi.fn(() => true),
  addEdge: vi.fn(() => true),
  runCanvasUndoBatch: vi.fn((_p: string, _s: string, run: () => void) => {
    run();
  }),
}));
vi.mock('@web/data/api/canvas', () => ({
  canvasApi: {
    understand: vi.fn(async () => ({ task_id: 't-1', status: 'pending' })),
    fetchUnderstandConfig: vi.fn(async () => ({ maxMediaBytes: 20 * 1024 * 1024 })),
  },
}));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn() },
}));

import { addEdge, addNode, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { canvasApi } from '@web/data/api/canvas';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';

import { startUnderstandRun } from '@web/spaces/canvas/start-understand-run';

const RUN = {
  projectId: 'p-1',
  spaceId: 's-1',
  userId: 'u-1',
  source: {
    id: 'n-1',
    kind: 'image' as const,
    url: 'https://assets.invalid/image/a.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    position: { x: 100, y: 40 },
    groupOrigin: null,
  },
};

describe('one press of Understand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the node and its edge in one undo step, then asks for the run', async () => {
    await startUnderstandRun(RUN);

    expect(runCanvasUndoBatch).toHaveBeenCalledTimes(1);
    expect(addNode).toHaveBeenCalledTimes(1);
    expect(addEdge).toHaveBeenCalledTimes(1);

    // The edge runs from the node being read to the node being written, which
    // is the only thing tying the two together — there is no parent and no
    // shared id, so a reader who wants them apart deletes it.
    const [, , edge] = vi.mocked(addEdge).mock.calls[0] ?? [];
    expect(edge?.source).toBe('n-1');

    const [node] = vi.mocked(addNode).mock.calls[0]?.slice(2) ?? [];
    expect(node).toMatchObject({ type: 'text' });
    expect(vi.mocked(canvasApi.understand)).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'p-1',
        space_id: 's-1',
        source_type: 'image',
        source_url: RUN.source.url,
        node_ids: [(node as { id: string }).id],
      }),
    );
  });

  it('builds nothing when the file is in a format the endpoint cannot read', async () => {
    await startUnderstandRun({
      ...RUN,
      source: { ...RUN.source, kind: 'audio', mimeType: 'audio/webm' },
    });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(addNode).not.toHaveBeenCalled();
    expect(addEdge).not.toHaveBeenCalled();
    expect(vi.mocked(canvasApi.understand)).not.toHaveBeenCalled();
  });

  it('builds nothing when the file is over the ceiling', async () => {
    await startUnderstandRun({
      ...RUN,
      source: { ...RUN.source, sizeBytes: 20 * 1024 * 1024 + 1 },
    });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(addNode).not.toHaveBeenCalled();
    expect(vi.mocked(canvasApi.understand)).not.toHaveBeenCalled();
  });

  // The node stays. It is the reader's content now, and nothing here deletes
  // one — a request that never reached the server has no row to carry its
  // failure, so the toast is the whole of what can be said.
  it('keeps the node when the request never reaches the server', async () => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(new Error('offline'));

    await startUnderstandRun(RUN);

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});

describe('when the press cannot reach its end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The ceilings come from the server, and asking for them is the first
  // thing this does. A press that dies there has built nothing, so there is
  // no row anywhere for the refusal to land on — which is exactly the class
  // of problem a toast is for.
  it('says so when the ceilings cannot be fetched', async () => {
    vi.mocked(canvasApi.fetchUnderstandConfig).mockRejectedValueOnce(
      new Error('offline'),
    );

    await startUnderstandRun(RUN);

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addNode)).not.toHaveBeenCalled();
    expect(vi.mocked(canvasApi.understand)).not.toHaveBeenCalled();
  });

  // A request the server answered opened a row on the node and settled it
  // with the cause — "Not enough credits." is already on screen. A toast on
  // top of it says the same failure twice and tells the reader to try again,
  // which with the same balance fails identically.
  it('leaves a refusal the server answered to the row it settled', async () => {
    // A real one: the branch reads what the type carries, and a look-alike
    // built from a plain Error would pass the assertion while the code under
    // test sees something else.
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(
      new ApiException({ status: 402, message: 'Not enough credits' }),
    );

    await startUnderstandRun(RUN);

    expect(vi.mocked(addNode)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  // Nothing answered, so nothing opened a row: this is the only place it can
  // be said.
  it('says so when the request never arrived', async () => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(new Error('network'));

    await startUnderstandRun(RUN);

    expect(vi.mocked(addNode)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
  });
});
