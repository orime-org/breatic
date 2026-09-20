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
  },
  getCachedUnderstandMaxBytes: vi.fn(() => 20 * 1024 * 1024),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn() },
}));
vi.mock('@breatic/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLocale: vi.fn(() => 'zh-CN'),
}));

import { addEdge, addNode, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { canvasApi, getCachedUnderstandMaxBytes } from '@web/data/api/canvas';
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

  // The answer becomes this node's body, and the reader opens it in the
  // language they set. Only this end knows which that is, so it travels with
  // the request; the model, four processes away, is what writes the sentence.
  it('sends the language the reader set', async () => {
    await startUnderstandRun(RUN);

    expect(vi.mocked(canvasApi.understand)).toHaveBeenCalledWith(
      expect.objectContaining({ reader_locale: 'zh-CN' }),
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
    vi.mocked(getCachedUnderstandMaxBytes).mockReturnValue(20 * 1024 * 1024);
  });

  // The ceiling rides on the knobs the canvas already warms on mount, and a
  // press reads whatever is cached. Nothing has loaded yet is not a reason to
  // refuse a press: the run reads the same ceiling from the same file, so an
  // ungated press is judged there instead of not happening at all.
  it('goes ahead when the ceiling has not loaded yet', async () => {
    vi.mocked(getCachedUnderstandMaxBytes).mockReturnValue(null);

    await startUnderstandRun(RUN);

    expect(addNode).toHaveBeenCalledTimes(1);
    expect(canvasApi.understand).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  // A rejection means no row was opened: the endpoint answers 201 with the
  // row's own state once one exists, so anything that arrives here left the
  // node with nothing on it and nothing coming. The press is then the only
  // place the reason can be said, whatever the status was.
  it.each([
    ['a caller the project would not take', 403],
    ['a row the server could not open', 503],
    ['a request that never arrived', 0],
    ['a run that named no node, refused for credits', 402],
  ])('says so on %s', async (_case, status) => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(
      new ApiException({ status, message: 'no' }),
    );

    await startUnderstandRun(RUN);

    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
