// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.hoisted(() => ({ uploadMedia: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  uploadMedia: upload.uploadMedia,
}));

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
});
