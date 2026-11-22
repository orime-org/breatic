// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Handing a registered focus crop to collab (#1580).
 *
 * The node's pool lives in the canvas Space's Yjs document, so the backend publishes the image with the address off
 * the registered record and collab adds it, the way a Document block receives its upload (`document-upload-events`).
 * The event is the only way the crop reaches the pool, so failing to publish it throws: an upload finish job runs
 * again, and a ticket answered by a dedup hit fails and the page shows the failure.
 */

import { getStreamRedis, publishFocusImageUploadEvent } from "@breatic/core";
import { canvasSpaceDocName, FOCUS_IMAGE_UPLOAD_EVENT_TYPE, type StudioAssetEntity } from "@breatic/shared";
import type { GrantFocusImage, UploadGrant } from "@domain/asset/upload-grant.repo.js";

/** Where a crop goes and what it becomes. */
export interface FocusImageTarget {
  projectId: string;
  focusImage: GrantFocusImage;
}

/**
 * The pool a grant's bytes land in, when it is a focus crop's.
 * @param grant - The upload's grant.
 * @returns The target, or null.
 */
export function focusImageTargetOf(grant: Pick<UploadGrant, "projectId" | "focusImage">): FocusImageTarget | null {
  if (grant.projectId === null || grant.focusImage === null) return null;
  return { projectId: grant.projectId, focusImage: grant.focusImage };
}

/**
 * Hand collab the crop with its registered address; bytes that are not a picture are never added to a pool.
 * @param target - The pool and the image.
 * @param asset - The registered asset.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceFocusImage(
  target: FocusImageTarget,
  asset: Pick<StudioAssetEntity, "fileUrl"> & { kind: string },
): Promise<void> {
  if (asset.kind !== "image") return;
  const { spaceId, nodeId, id, name, width, height } = target.focusImage;
  await publishFocusImageUploadEvent(getStreamRedis(), {
    type: FOCUS_IMAGE_UPLOAD_EVENT_TYPE,
    docName: canvasSpaceDocName(target.projectId, spaceId),
    nodeId,
    image: { id, url: asset.fileUrl, name, width, height },
  });
}
