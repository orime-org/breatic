// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.hoisted(() => ({ uploadMedia: vi.fn() }));
const assets = vi.hoisted(() => ({ reportFocusUploadFailure: vi.fn() }));
vi.mock('@web/data/api/assets', async (importOriginal) => {
  const real = await importOriginal<typeof import('@web/data/api/assets')>();
  return { ...real, assetsApi: { ...real.assetsApi, reportFocusUploadFailure: assets.reportFocusUploadFailure } };
});
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  uploadMedia: upload.uploadMedia,
}));

import { UploadFailedError } from '@web/data/upload/media-upload';
import { uploadDerivedImage, uploadFocusCrop } from '@web/spaces/canvas/upload-derived-image';

const WHERE = { projectId: 'p1', spaceId: 's1' };
const FILE = new File(['x'], 'a.png', { type: 'image/png' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('uploadDerivedImage', () => {
  it('uploads as a byproduct with no node and answers where it is kept', async () => {
    upload.uploadMedia.mockResolvedValue({ fileUrl: 'https://cdn/a.png' });
    await expect(uploadDerivedImage(FILE, WHERE)).resolves.toBe('https://cdn/a.png');
    expect(upload.uploadMedia).toHaveBeenCalledWith(FILE, { projectId: 'p1', spaceId: 's1', derived: true });
  });
});

describe('uploadFocusCrop', () => {
  it('names the pool the crop lands in and tells the caller once the bytes are sent', async () => {
    upload.uploadMedia.mockResolvedValue({ fileUrl: 'https://cdn/a.png' });
    const onSent = vi.fn();
    const image = { id: 'crop-1', name: 'Kyoto', width: 4, height: 3 };
    await uploadFocusCrop(FILE, { ...WHERE, nodeId: 'n1' }, image, onSent);
    expect(upload.uploadMedia).toHaveBeenCalledWith(
      FILE,
      { projectId: 'p1', spaceId: 's1', derived: true, focusImage: { nodeId: 'n1', ...image } },
      undefined,
      undefined,
      onSent,
    );
  });

  it('tells the server a crop whose bytes never left, as a node upload reports its row, and still fails', async () => {
    assets.reportFocusUploadFailure.mockResolvedValue(undefined);
    upload.uploadMedia.mockRejectedValue(new UploadFailedError('transfer', 'image/k.png'));
    const image = { id: 'crop-1', name: 'Kyoto', width: 4, height: 3 };
    await expect(uploadFocusCrop(FILE, { ...WHERE, nodeId: 'n1' }, image)).rejects.toMatchObject({ reason: 'transfer' });
    expect(assets.reportFocusUploadFailure).toHaveBeenCalledExactlyOnceWith('image/k.png');
  });

  it('reports nothing for a failure the server already knows of', async () => {
    upload.uploadMedia.mockRejectedValue(new UploadFailedError('upload'));
    const image = { id: 'crop-1', name: 'Kyoto', width: 4, height: 3 };
    await expect(uploadFocusCrop(FILE, { ...WHERE, nodeId: 'n1' }, image)).rejects.toMatchObject({ reason: 'upload' });
    expect(assets.reportFocusUploadFailure).not.toHaveBeenCalled();
  });
});
