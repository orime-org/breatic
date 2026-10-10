// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upload = vi.hoisted(() => ({ uploadMedia: vi.fn() }));
vi.mock('@web/data/upload/media-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/upload/media-upload')>()),
  uploadMedia: upload.uploadMedia,
}));

import { UploadFailedError } from '@web/data/upload/media-upload';
import { uploadDerivedImage } from '@web/spaces/canvas/upload-derived-image';

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

  it('fails as an upload when the answer carries no address', async () => {
    upload.uploadMedia.mockResolvedValue({});
    await expect(uploadDerivedImage(FILE, WHERE)).rejects.toEqual(new UploadFailedError('upload'));
  });
});
