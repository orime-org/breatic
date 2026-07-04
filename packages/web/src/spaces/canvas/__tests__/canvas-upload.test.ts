// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';

import {
  fileToNodeSpec,
  fillNodeFromFile,
  runMediaUpload,
  computeDeletedAssetEntries,
} from '@web/spaces/canvas/canvas-upload';

describe('fileToNodeSpec — MIME → which node + whether to upload', () => {
  it('routes images to an image node that needs uploading', () => {
    expect(fileToNodeSpec({ type: 'image/png' })).toEqual({
      nodeType: 'image',
      needsUpload: true,
    });
  });

  it('routes video / audio to their media nodes (need upload)', () => {
    expect(fileToNodeSpec({ type: 'video/mp4' })).toEqual({
      nodeType: 'video',
      needsUpload: true,
    });
    expect(fileToNodeSpec({ type: 'audio/mpeg' })).toEqual({
      nodeType: 'audio',
      needsUpload: true,
    });
  });

  it('routes text files to a text node (no upload — content read/extracted locally)', () => {
    expect(fileToNodeSpec({ type: 'text/plain' })).toEqual({
      nodeType: 'text',
      needsUpload: false,
    });
    expect(fileToNodeSpec({ type: 'text/markdown' })).toEqual({
      nodeType: 'text',
      needsUpload: false,
    });
  });

  it('routes EVERY non-media file to a text node (pdf/docx/xlsx/binary — extracted, never rejected)', () => {
    const text = { nodeType: 'text', needsUpload: false };
    expect(fileToNodeSpec({ type: 'application/pdf' })).toEqual(text);
    expect(
      fileToNodeSpec({
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toEqual(text);
    expect(
      fileToNodeSpec({
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toEqual(text);
    expect(fileToNodeSpec({ type: 'application/octet-stream' })).toEqual(text);
    expect(fileToNodeSpec({ type: '' })).toEqual(text);
  });
});

describe('runMediaUpload — presign → PUT → success / failure callbacks', () => {
  const file = new File(['x'], 'photo.png', { type: 'image/png' });

  it('presigns with the file name + type, PUTs, then reports the public URL', async () => {
    const presign = vi
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://put', fileUrl: 'https://cdn/p.png', key: 'k', kind: 'image' });
    const putFile = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await runMediaUpload(file, 'p1', { presign, putFile, onSuccess, onFailure });

    expect(presign).toHaveBeenCalledWith({
      filename: 'photo.png',
      contentType: 'image/png',
      projectId: 'p1',
    });
    expect(putFile).toHaveBeenCalledWith('https://put', file);
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith('https://cdn/p.png');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports failure when presign throws (PUT not attempted)', async () => {
    const presign = vi.fn().mockRejectedValue(new Error('403'));
    const putFile = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await runMediaUpload(file, 'p1', { presign, putFile, onSuccess, onFailure });

    expect(putFile).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('reports failure when the PUT throws', async () => {
    const presign = vi
      .fn()
      .mockResolvedValue({ uploadUrl: 'https://put', fileUrl: 'https://cdn/p.png', key: 'k', kind: 'image' });
    const putFile = vi.fn().mockRejectedValue(new Error('network'));
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await runMediaUpload(file, 'p1', { presign, putFile, onSuccess, onFailure });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
  });
});

describe('fillNodeFromFile — fill an EXISTING node from a picked file (double-click / Upload menu)', () => {
  /** The owner triple the stubbed setHandling hands back (#1580 #7). */
  const LEASE = { gen: 1, clientId: 7, userId: 'u1' };

  /** Build the injected sinks + spies for a fill run. */
  function makeDeps(over: Partial<Parameters<typeof fillNodeFromFile>[4]> = {}) {
    return {
      presign: vi.fn().mockResolvedValue({
        uploadUrl: 'https://put',
        fileUrl: 'https://cdn/p.png',
        key: 'k',
        kind: 'image',
      }),
      putFile: vi.fn().mockResolvedValue(undefined),
      extractText: vi.fn().mockResolvedValue('extracted body'),
      isHandling: vi.fn().mockReturnValue(false),
      onBusy: vi.fn(),
      onTypeMismatch: vi.fn(),
      setHandling: vi.fn().mockReturnValue(LEASE),
      setContent: vi.fn().mockReturnValue(true),
      setError: vi.fn().mockReturnValue(true),
      ...over,
    };
  }

  it('media file: handling → upload → fill content with the public URL (no new node)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith('n1', 'https://cdn/p.png', LEASE);
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.extractText).not.toHaveBeenCalled();
  });

  it('media upload failure: writes a fixed-English error onto the node (not a toast)', async () => {
    const deps = makeDeps({ presign: vi.fn().mockRejectedValue(new Error('403')) });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'bad.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('n1', 'Upload failed: bad.png', LEASE);
  });

  it('non-media file: extract text locally → fill content (no upload)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'doc.txt', { type: 'text/plain' }),
      'text',
      'p1',
      deps,
    );
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith('n1', 'extracted body', LEASE);
  });

  it('extraction failure: writes a fixed-English error', async () => {
    const deps = makeDeps({
      extractText: vi.fn().mockRejectedValue(new Error('no parser')),
    });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'weird.bin', { type: 'application/octet-stream' }),
      'text',
      'p1',
      deps,
    );
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('n1', 'Extraction failed: weird.bin', LEASE);
  });

  it('busy gate (#1580 #7): a node already handling refuses the fill — onBusy fires, nothing else runs', async () => {
    const deps = makeDeps({ isHandling: vi.fn().mockReturnValue(true) });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.onBusy).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setHandling).not.toHaveBeenCalled();
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('missing node (#1580 #7): setHandling returns undefined — the fill aborts silently', async () => {
    const deps = makeDeps({ setHandling: vi.fn().mockReturnValue(undefined) });
    await fillNodeFromFile(
      'ghost',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'image',
      'p1',
      deps,
    );
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('type gate: an mp4 VIDEO picked into an AUDIO node is refused - nothing runs (user bug 2026-07-03: macOS lets audio/* pickers select .mp4)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'clip.mp4', { type: 'video/mp4' }),
      'audio',
      'p1',
      deps,
    );
    expect(deps.onTypeMismatch).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setHandling).not.toHaveBeenCalled();
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });

  it('type gate: an audio-only mp4 container (audio/mp4, .m4a) into an AUDIO node is ACCEPTED', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'song.m4a', { type: 'audio/mp4' }),
      'audio',
      'p1',
      deps,
    );
    expect(deps.onTypeMismatch).not.toHaveBeenCalled();
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
  });

  it('type gate: an image into a TEXT node is refused (the gate is generic, not audio-specific)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'text',
      'p1',
      deps,
    );
    expect(deps.onTypeMismatch).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setHandling).not.toHaveBeenCalled();
  });
});

describe('computeDeletedAssetEntries — asset-delete report accounting', () => {
  const url = (n: string): string => `https://cdn/${n}.png`;

  it('reports a deleted media node\'s content + cover as separate entries', () => {
    const deleted = [
      { id: 'v1', type: 'video', data: { content: url('vid'), coverUrl: url('cover') } },
    ];
    const entries = computeDeletedAssetEntries(deleted, deleted, 'sp-1');
    expect(entries.map((e) => e.fileUrl).sort()).toEqual([url('cover'), url('vid')].sort());
    expect(entries.every((e) => e.nodeId === 'v1' && e.spaceId === 'sp-1')).toBe(true);
  });

  it('does NOT report a URL still referenced by a surviving node (pasted duplicate)', () => {
    const shared = url('shared');
    const deleted = [{ id: 'a', type: 'image', data: { content: shared } }];
    const all = [
      { id: 'a', type: 'image', data: { content: shared } },
      { id: 'b', type: 'image', data: { content: shared } }, // survivor holds the same URL
    ];
    expect(computeDeletedAssetEntries(deleted, all, 'sp-1')).toEqual([]);
  });

  it('reports the URL once the LAST referencing node is deleted', () => {
    const shared = url('shared');
    const deleted = [
      { id: 'a', type: 'image', data: { content: shared } },
      { id: 'b', type: 'image', data: { content: shared } },
    ];
    const entries = computeDeletedAssetEntries(deleted, deleted, 'sp-1');
    expect(entries.map((e) => e.fileUrl)).toContain(shared);
  });

  it('skips non-media nodes and non-http content (data:/blob: placeholders, errors)', () => {
    const deleted = [
      { id: 't', type: 'text', data: { content: url('ignored') } },
      { id: 'i', type: 'image', data: { content: 'data:image/png;base64,AAAA' } },
      { id: 'e', type: 'image', data: { content: 'Upload failed: x.png' } },
    ];
    expect(computeDeletedAssetEntries(deleted, deleted, 'sp-1')).toEqual([]);
  });
});
