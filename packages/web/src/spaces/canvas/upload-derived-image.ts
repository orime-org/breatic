// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { assetsApi } from '@web/data/api/assets';
import { UploadFailedError, uploadMedia } from '@web/data/upload/media-upload';
import type { FocusCropImage } from '@web/spaces/canvas/focus/run-focus-crop';

/**
 * Upload an image made in the browser from canvas content: a mini-tool's
 * drawing, a 3D viewfinder shot. It has no node of its own, so there is no
 * handling to fence and nothing for the server to announce to; the address is
 * read from the answer. A focus crop goes through {@link uploadFocusCrop}. It is registered in the ledger for attribution and dedup,
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
  return fileUrl;
}

/**
 * Upload a focus crop as the image it becomes in a node's pool (#1580). Collab adds the image once the bytes are
 * registered, so nothing is read from the answer; this ends when the upload has, and `onSent` tells the caller
 * earlier, once the bytes are sent and only the registration is left.
 * @param file - The crop.
 * @param where - The project, the canvas Space and the node whose pool takes it.
 * @param where.projectId - The project.
 * @param where.spaceId - The canvas Space.
 * @param where.nodeId - The node.
 * @param image - The image the crop becomes: its id, name and size.
 * @param onSent - Called once the bytes are sent and await registration.
 * @returns Nothing, once the upload ended well.
 * @throws {UploadFailedError} When the upload does not complete.
 */
export async function uploadFocusCrop(
  file: File,
  where: { projectId: string; spaceId: string; nodeId: string },
  image: FocusCropImage,
  onSent?: () => void,
): Promise<void> {
  try {
    await uploadMedia(file, {
      projectId: where.projectId,
      spaceId: where.spaceId,
      derived: true,
      focusImage: { nodeId: where.nodeId, ...image },
    }, undefined, undefined, onSent);
  } catch (err) {
    // Bytes that never reached the edge end nowhere else: told, the server ends the crop in its node, as a node
    // upload's row is reported (upload-into-node.ts); an untold one shows as uploading until its deadline.
    if (err instanceof UploadFailedError && err.storageKey !== undefined) {
      const { storageKey } = err;
      void assetsApi.reportFocusUploadFailure(storageKey).catch((reportErr: unknown) => {
        console.warn('focus upload failure report rejected', storageKey, reportErr);
      });
    }
    throw err;
  }
}
