// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';

import {
  fileToNodeSpec,
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

  it('routes text files to a text node read locally (no upload)', () => {
    expect(fileToNodeSpec({ type: 'text/plain' })).toEqual({
      nodeType: 'text',
      needsUpload: false,
    });
    expect(fileToNodeSpec({ type: 'text/markdown' })).toEqual({
      nodeType: 'text',
      needsUpload: false,
    });
  });

  it('returns null for unsupported types (no canvas node form)', () => {
    expect(fileToNodeSpec({ type: 'application/pdf' })).toBeNull();
    expect(fileToNodeSpec({ type: 'application/octet-stream' })).toBeNull();
    expect(fileToNodeSpec({ type: '' })).toBeNull();
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
