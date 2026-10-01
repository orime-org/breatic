// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import {
  PictureUploadError,
  pictureFailureOf,
  uploadPicture,
} from '@web/pages/studio/shared/upload-picture';
import type { runMediaUpload } from '@web/spaces/canvas/canvas-upload';

type Run = typeof runMediaUpload;

/**
 * A stand-in for the upload pipeline that ends the way the test says.
 * @param end - Calls one of the pipeline's two outcome callbacks.
 * @returns The stub and the calls it received.
 */
function pipeline(
  end: (deps: Parameters<Run>[2]) => void,
): Run & { mock: { calls: Parameters<Run>[] } } {
  return vi.fn(async (_file, _context, deps) => {
    end(deps);
  }) as unknown as Run & { mock: { calls: Parameters<Run>[] } };
}

const blob = new Blob(['x'], { type: 'image/jpeg' });

describe('uploadPicture', () => {
  it('uploads the picture as a file of its own type and resolves the ledger row', async () => {
    const run = pipeline((deps) => deps.onSuccess({ fileUrl: 'u', assetId: 'asset-1' }));

    const assetId = await uploadPicture(
      blob,
      { projectId: 'p1', purpose: 'project_cover' },
      run,
    );

    expect(assetId).toBe('asset-1');
    const [file, context] = run.mock.calls[0]!;
    expect(file.type).toBe('image/jpeg');
    expect(file.name).toBe('picture.jpg');
    expect(context).toEqual({ projectId: 'p1', purpose: 'project_cover' });
  });

  it('fails with the pipeline\'s reason, so the caller can say why', async () => {
    const run = pipeline((deps) => deps.onFailure({ reason: 'storage' }));

    const failure = await uploadPicture(blob, { studioId: 's1', purpose: 'studio_avatar' }, run)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PictureUploadError);
    expect((failure as PictureUploadError).reason).toBe('storage');
  });

  it('fails when the upload ended without naming a ledger row', async () => {
    const run = pipeline((deps) => deps.onSuccess({ fileUrl: undefined, assetId: undefined }));

    const failure = await uploadPicture(blob, { studioId: 's1', purpose: 'studio_avatar' }, run)
      .catch((err: unknown) => err);

    expect((failure as PictureUploadError).reason).toBe('upload');
  });
});

describe('pictureFailureOf', () => {
  it('names a full account and a refused format, and folds everything else into one retryable failure', () => {
    expect(pictureFailureOf(new PictureUploadError('storage'))).toBe('storage');
    expect(pictureFailureOf(new PictureUploadError('unsupportedType'))).toBe('unsupportedType');
    expect(pictureFailureOf(new PictureUploadError('hash'))).toBe('upload');
    expect(pictureFailureOf(new PictureUploadError('transfer'))).toBe('upload');
    expect(pictureFailureOf(new Error('network'))).toBe('upload');
  });
});
