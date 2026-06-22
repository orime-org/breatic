// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';

import {
  fileToNodeSpec,
  fillNodeFromFile,
  runMediaUpload,
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
  /** Build the injected sinks + spies for a fill run. */
  function makeDeps(over: Partial<Parameters<typeof fillNodeFromFile>[3]> = {}) {
    return {
      presign: vi.fn().mockResolvedValue({
        uploadUrl: 'https://put',
        fileUrl: 'https://cdn/p.png',
        key: 'k',
        kind: 'image',
      }),
      putFile: vi.fn().mockResolvedValue(undefined),
      extractText: vi.fn().mockResolvedValue('extracted body'),
      setHandling: vi.fn(),
      setContent: vi.fn(),
      setError: vi.fn(),
      ...over,
    };
  }

  it('media file: handling → upload → fill content with the public URL (no new node)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'p.png', { type: 'image/png' }),
      'p1',
      deps,
    );
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith('n1', 'https://cdn/p.png');
    expect(deps.setError).not.toHaveBeenCalled();
    expect(deps.extractText).not.toHaveBeenCalled();
  });

  it('media upload failure: writes a fixed-English error onto the node (not a toast)', async () => {
    const deps = makeDeps({ presign: vi.fn().mockRejectedValue(new Error('403')) });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'bad.png', { type: 'image/png' }),
      'p1',
      deps,
    );
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('n1', 'Upload failed: bad.png');
  });

  it('non-media file: extract text locally → fill content (no upload)', async () => {
    const deps = makeDeps();
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'doc.txt', { type: 'text/plain' }),
      'p1',
      deps,
    );
    expect(deps.setHandling).toHaveBeenCalledExactlyOnceWith('n1');
    expect(deps.presign).not.toHaveBeenCalled();
    expect(deps.setContent).toHaveBeenCalledExactlyOnceWith('n1', 'extracted body');
  });

  it('extraction failure: writes a fixed-English error', async () => {
    const deps = makeDeps({
      extractText: vi.fn().mockRejectedValue(new Error('no parser')),
    });
    await fillNodeFromFile(
      'n1',
      new File(['x'], 'weird.bin', { type: 'application/octet-stream' }),
      'p1',
      deps,
    );
    expect(deps.setContent).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledExactlyOnceWith('n1', 'Extraction failed: weird.bin');
  });
});
