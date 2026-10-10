// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload a cropped picture — a project cover or a studio avatar — as an
 * ordinary asset, and hand back the ledger row it landed on.
 *
 * It is the same pipeline every asset takes (hash → ticket → the ingest
 * Worker, or nothing at all on a dedup hit), so the picture counts toward
 * storage and dedups like anything else. Pointing the project or the studio at
 * the row is the caller's next call.
 */

import { ApiException } from '@web/data/api/types';
import type { UploadContext } from '@web/data/upload/ingest-upload';
import { UploadFailedError, uploadMedia, type UploadFailureReason } from '@web/data/upload/media-upload';

/**
 * What a failed picture upload tells the person: their account is full, the
 * format is not one we take, the page could not fingerprint the file (a reload
 * fixes it, a retry on this page does not), they are uploading too often (a
 * retry after a while goes through), or something else a retry may fix.
 */
export type PictureFailure = Exclude<UploadFailureReason, 'transfer'>;

/**
 * Reduce whatever a picture upload threw to what the person is told.
 * @param err - What the upload or the pointer call threw.
 * @returns The failure to show.
 */
export function pictureFailureOf(err: unknown): PictureFailure {
  if (!(err instanceof UploadFailedError)) return 'upload';
  // A transfer that broke off is one more failure a retry may fix.
  return err.reason === 'transfer' ? 'upload' : err.reason;
}

/** The sentences both pictures share, by failure. */
const SHARED_MESSAGE: Readonly<Record<Exclude<PictureFailure, keyof PictureMessageKeys>, string>> = {
  unsupportedType: 'studio.container.imageError.unsupported_type',
  hash: 'studio.container.imageError.hash_unavailable',
  rateLimited: 'studio.container.imageError.rate_limited',
};

/** The caller's own sentences: the two failures that name the picture. */
export interface PictureMessageKeys {
  /** The account is out of room. */
  storage: string;
  /** Anything else a retry may fix. */
  upload: string;
}

/**
 * The sentence a failed cover or avatar upload shows in its crop dialog.
 *
 * A refusal the server wrote — pointing at the uploaded row was not allowed —
 * is shown as written. A full account and any other failure read in the
 * caller's own sentences, since they name the picture; a refused format and an
 * unhashable file are the same sentence for both pictures.
 * @param err - What the upload or the pointer call threw.
 * @param t - The translator.
 * @param keys - The caller's message keys, written out so every key in use is
 *   spelled somewhere a reader of the catalogs can find it.
 * @returns The sentence to show.
 */
export function pictureErrorMessage(
  err: unknown,
  t: (key: string) => string,
  keys: PictureMessageKeys,
): string {
  if (err instanceof ApiException && err.fromServer) return err.message;
  const failure = pictureFailureOf(err);
  const messages: Record<PictureFailure, string> = { ...SHARED_MESSAGE, ...keys };
  return t(messages[failure]);
}

/** The extension a picture's file is named with, by its type. */
const EXTENSION: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * Upload the picture and resolve the ledger row it landed on.
 * @param picture - The encoded crop.
 * @param context - Where it lands and what it is for.
 * @param upload - The upload; tests pass a stand-in.
 * @returns The asset id to point the project or the studio at.
 * @throws {UploadFailedError} When the upload fails, or ends without naming a row.
 */
export async function uploadPicture(
  picture: Blob,
  context: UploadContext,
  upload: typeof uploadMedia = uploadMedia,
): Promise<string> {
  const file = new File([picture], `picture.${EXTENSION[picture.type] ?? 'png'}`, {
    type: picture.type,
  });
  const { assetId } = await upload(file, context);
  if (assetId === undefined) throw new UploadFailedError('upload');
  return assetId;
}
