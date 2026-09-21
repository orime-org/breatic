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
  onBuilt: (): void => {},
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

  // The gate above judged this file by the type the ledger recorded off its
  // landed bytes. The run reads the same address from storage, which answers
  // with the type a ticket signed — guessed from a file name. Sending the
  // judged one is what keeps the two gates from disagreeing about one file.
  it('sends the type the gate above judged by', async () => {
    await startUnderstandRun(RUN);

    expect(vi.mocked(canvasApi.understand)).toHaveBeenCalledWith(
      expect.objectContaining({ source_mime_type: RUN.source.mimeType }),
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

  // The node lands one whole step to the right of the one being read, which
  // on a canvas scrolled anywhere near its right edge is off-screen — and a
  // press whose only effect is off-screen looks like a press that did
  // nothing. Every other way a node is born here hands it back to be
  // selected, and this is that hand-back.
  it('hands the node it built back to the canvas, and where it put it', async () => {
    const onBuilt = vi.fn();

    await startUnderstandRun({ ...RUN, onBuilt });

    const [node] = vi.mocked(addNode).mock.calls[0]?.slice(2) ?? [];
    expect(onBuilt).toHaveBeenCalledTimes(1);
    // The position travels with the id because the canvas has to look at this
    // node, and where it is is the whole of what looking at it needs. It is
    // absolute: a source inside a group stores a position relative to that
    // group, and this node is top-level.
    expect(onBuilt).toHaveBeenCalledWith({
      id: (node as { id: string }).id,
      position: { x: RUN.source.position.x + 312, y: RUN.source.position.y },
    });
  });

  // The wire is the only thing tying the reading to what it is about, and the
  // node it runs from can go while the menu stands open: `addEdge` refuses an
  // edge whose endpoint is gone and says so in its return. The reading still
  // has the address it captured, so it goes ahead and the reader is told the
  // wire is missing.
  it('says so when the wire to the node being read cannot be drawn', async () => {
    vi.mocked(addEdge).mockReturnValueOnce(false);

    await startUnderstandRun(RUN);

    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(
      'The node being read is gone. This reading has no wire to it.',
    );
    expect(vi.mocked(canvasApi.understand)).toHaveBeenCalledTimes(1);
  });

  it('hands nothing back when it built nothing', async () => {
    const onBuilt = vi.fn();

    await startUnderstandRun({
      ...RUN,
      onBuilt,
      source: { ...RUN.source, kind: 'audio', mimeType: 'audio/webm' },
    });

    expect(onBuilt).not.toHaveBeenCalled();
  });

  it('builds nothing when the file is in a format the endpoint cannot read', async () => {
    await startUnderstandRun({
      ...RUN,
      source: { ...RUN.source, kind: 'audio', mimeType: 'audio/webm' },
    });

    // The sentence names the file the reader picked and what it is in, not
    // the ten formats a reading takes — nine of which are not the one in
    // their hand (user 2026-09-20). The name is the asset's own, read off
    // the address, which is the same one the run would read.
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      'Cannot understand this file type (a.png, WebM).',
    );
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

  // Presses come in faster than the run behind them, and the throttle answers
  // with a sentence written in the reader's own language saying which of those
  // two just happened. Saying "try again" over it sends the reader back into
  // the window they are already inside, where the next press fails the same
  // way and leaves another node behind.
  it('says what the server said when the server said it', async () => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(
      new ApiException({
        status: 429,
        message: '请求过于频繁，请稍后再试',
        fromServer: true,
      }),
    );

    await startUnderstandRun(RUN);

    expect(toast.error).toHaveBeenCalledWith('请求过于频繁，请稍后再试');
  });

  // A permission refusal is written for the reader and it repeats: telling
  // them to try again sends them at a door that answers the same way.
  it('passes on a refusal the reader is the subject of', async () => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(
      new ApiException({
        status: 403,
        message: '没有权限执行此操作',
        fromServer: true,
      }),
    );

    await startUnderstandRun(RUN);

    expect(toast.error).toHaveBeenCalledWith('没有权限执行此操作');
  });

  // Every branch of the error handler writes its message through `t()`,
  // including the one a rejected schema takes, so a refusal the server wrote
  // reaches the reader in their own language whatever its status was.
  it('passes on a refusal the server wrote, whatever the status', async () => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(
      new ApiException({
        status: 422,
        message: '请求格式不正确',
        fromServer: true,
      }),
    );

    await startUnderstandRun(RUN);

    expect(toast.error).toHaveBeenCalledWith('请求格式不正确');
  });

  // Nothing answered, so there is no sentence to pass on and the press is
  // where the reason has to be said.
  it('says its own line when the answer carried no sentence', async () => {
    vi.mocked(canvasApi.understand).mockRejectedValueOnce(
      new ApiException({ status: 0, message: 'Network Error' }),
    );

    await startUnderstandRun(RUN);

    expect(toast.error).toHaveBeenCalledWith('Could not start. Try again.');
  });
});
