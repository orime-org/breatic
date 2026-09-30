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

import { assetsApi } from '@web/data/api/assets';
import { sendFileAndFinish } from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import {
  runMediaUpload,
  type UploadContext,
  type UploadFailureReason,
} from '@web/spaces/canvas/canvas-upload';

/** Why a picture did not upload; the caller picks the message from it. */
export class PictureUploadError extends Error {
  /**
   * Name the reason the picture did not upload.
   * @param reason - The upload pipeline's verdict.
   */
  constructor(readonly reason: UploadFailureReason) {
    super(reason);
    this.name = 'PictureUploadError';
  }
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
 * @param run - The upload pipeline; tests pass a stand-in.
 * @returns The asset id to point the project or the studio at.
 * @throws {PictureUploadError} When the upload fails, or ends without naming a row.
 */
export function uploadPicture(
  picture: Blob,
  context: UploadContext,
  run: typeof runMediaUpload = runMediaUpload,
): Promise<string> {
  const file = new File([picture], `picture.${EXTENSION[picture.type] ?? 'png'}`, {
    type: picture.type,
  });
  return new Promise((resolve, reject) => {
    void run(file, context, {
      getUploadConfig: assetsApi.fetchUploadConfig,
      hashFile,
      requestTicket: assetsApi.requestUploadTicket,
      sendToIngest: sendFileAndFinish,
      onSuccess: ({ assetId }) => {
        if (assetId === undefined) {
          reject(new PictureUploadError('upload'));
          return;
        }
        resolve(assetId);
      },
      onFailure: (outcome) => reject(new PictureUploadError(outcome.reason)),
    });
  });
}
