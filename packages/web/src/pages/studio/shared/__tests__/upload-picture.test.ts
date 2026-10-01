// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';

import { ApiException } from '@web/data/api/types';
import { UploadFailedError, type uploadMedia } from '@web/data/upload/media-upload';
import {
  pictureErrorMessage,
  pictureFailureOf,
  uploadPicture,
} from '@web/pages/studio/shared/upload-picture';

type Upload = typeof uploadMedia;

/**
 * A stand-in for the upload that ends the way the test says.
 * @param end - What the upload resolves with, or the error it rejects with.
 * @returns The stub, recording the calls it received.
 */
function upload(
  end: Awaited<ReturnType<Upload>> | UploadFailedError,
): Upload & { mock: { calls: Parameters<Upload>[] } } {
  return vi.fn(async () => {
    if (end instanceof UploadFailedError) throw end;
    return end;
  }) as unknown as Upload & { mock: { calls: Parameters<Upload>[] } };
}

const blob = new Blob(['x'], { type: 'image/jpeg' });

describe('uploadPicture', () => {
  it('uploads the picture as a file of its own type and resolves the ledger row', async () => {
    const run = upload({ fileUrl: 'u', assetId: 'asset-1' });

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

  it('fails with the upload\'s reason, so the caller can say why', async () => {
    const run = upload(new UploadFailedError('storage'));

    const failure = await uploadPicture(blob, { studioId: 's1', purpose: 'studio_avatar' }, run)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(UploadFailedError);
    expect((failure as UploadFailedError).reason).toBe('storage');
  });

  it('fails when the upload ended without naming a ledger row', async () => {
    const run = upload({ fileUrl: undefined, assetId: undefined });

    const failure = await uploadPicture(blob, { studioId: 's1', purpose: 'studio_avatar' }, run)
      .catch((err: unknown) => err);

    expect((failure as UploadFailedError).reason).toBe('upload');
  });
});

describe('the upload target', () => {
  it('pairs a studio with its avatar and a project with its cover, at compile time', () => {
    const run = upload({ fileUrl: 'u', assetId: 'a' });
    // @ts-expect-error a studio uploads nothing but its avatar
    void uploadPicture(blob, { studioId: 's1', purpose: 'project_cover' }, run);
    // @ts-expect-error a studio upload must say it is the avatar
    void uploadPicture(blob, { studioId: 's1' }, run);
    // @ts-expect-error a project does not upload a studio's avatar
    void uploadPicture(blob, { projectId: 'p1', purpose: 'studio_avatar' }, run);
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe('pictureFailureOf', () => {
  it('names a full account, a refused format and an unhashable file, and folds everything else into one retryable failure', () => {
    expect(pictureFailureOf(new UploadFailedError('storage'))).toBe('storage');
    expect(pictureFailureOf(new UploadFailedError('unsupportedType'))).toBe('unsupportedType');
    expect(pictureFailureOf(new UploadFailedError('hash'))).toBe('hash');
    expect(pictureFailureOf(new UploadFailedError('transfer'))).toBe('upload');
    expect(pictureFailureOf(new Error('network'))).toBe('upload');
  });
});

describe('pictureErrorMessage', () => {
  const KEYS = { storage: 'k.storage', upload: 'k.upload' };
  const t = (key: string): string => key;

  it('tells the person to reload when the file could not be fingerprinted', () => {
    expect(pictureErrorMessage(new UploadFailedError('hash'), t, KEYS)).toBe(
      'studio.container.imageError.hash_unavailable',
    );
  });

  it('names a refused format with the shared sentence', () => {
    expect(pictureErrorMessage(new UploadFailedError('unsupportedType'), t, KEYS)).toBe(
      'studio.container.imageError.unsupported_type',
    );
  });

  it('reads a full account and any other upload failure in the caller\'s own sentences', () => {
    expect(pictureErrorMessage(new UploadFailedError('storage'), t, KEYS)).toBe('k.storage');
    expect(pictureErrorMessage(new UploadFailedError('transfer'), t, KEYS)).toBe('k.upload');
  });

  it('shows what the server said when pointing at the uploaded row was refused', () => {
    const refused = new ApiException({ status: 403, message: 'Only the owner can do that.', fromServer: true });
    expect(pictureErrorMessage(refused, t, KEYS)).toBe('Only the owner can do that.');
  });

  it('keeps a transport failure to the caller\'s retry sentence, since its message is not written for a reader', () => {
    const dropped = new ApiException({ status: 0, message: 'Network Error', fromServer: false });
    expect(pictureErrorMessage(dropped, t, KEYS)).toBe('k.upload');
  });
});
