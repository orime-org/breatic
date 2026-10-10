// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { UploadFailedError, uploadMedia } from '@web/data/upload/media-upload';

/**
 * Upload an image made in the browser from canvas content: a focus crop, a
 * mini-tool's drawing. It has no node of its own, so there is no handling to
 * fence and nothing for the server to announce to; the address is read from
 * the answer. It is registered in the ledger for attribution and dedup,
 * without an activity-feed row of its own.
 * @param file - The image.
 * @param where - The project and Space it was made in.
 * @param where.projectId - The project.
 * @param where.spaceId - The Space.
 * @returns Where the image is kept.
 * @throws {UploadFailedError} When the upload does not complete, the reason
 *   naming why so the caller can say whether a retry helps.
 */
export async function uploadDerivedImage(file: File, where: { projectId: string; spaceId: string }): Promise<string> {
  const { fileUrl } = await uploadMedia(file, { projectId: where.projectId, spaceId: where.spaceId, derived: true });
  if (fileUrl === undefined) throw new UploadFailedError('upload');
  return fileUrl;
}
