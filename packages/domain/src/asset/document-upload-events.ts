// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Announcing a Document body media upload (breatic#1574).
 *
 * The block's address lives in the Document's Yjs document, so the backend
 * publishes and collab writes, the way a canvas node receives its upload
 * (`settleUploadTask`, `settleDedupHit`). An event carrying the ending is the
 * only way the ending reaches the block, so failing to publish it throws: an
 * upload finish job runs again, an address fetch job (one attempt) fails, and a
 * request (a dedup hit, or a fetch or finish that could not be queued) fails
 * and leaves the page to show the failure; the `processing` event only shows the wait
 * to the other members, and its loss is the caller's to log.
 */

import { getStreamRedis, publishDocumentUploadEvent } from "@breatic/core";
import {
  DOCUMENT_MEDIA_BLOCK_TYPES,
  documentSpaceDocName,
  readTaskFailure,
  type DocumentUploadEvent,
  type StudioAssetEntity,
} from "@breatic/shared";
import type { UploadGrant } from "@domain/asset/upload-grant.repo.js";

/** Where a Document upload's result goes. */
export interface DocumentUploadTarget {
  projectId: string;
  spaceId: string;
  uploadId: string;
}

// An asset's kind names the block it lands in.
const MEDIA_KINDS: ReadonlySet<string> = new Set(DOCUMENT_MEDIA_BLOCK_TYPES);

/**
 * The Document block a grant's bytes land in, when it names one.
 * @param grant - The upload's grant.
 * @returns The target, or null for an upload with no Document block.
 */
export function documentTargetOf(grant: Pick<UploadGrant, "projectId" | "spaceId" | "documentUploadId">): DocumentUploadTarget | null {
  if (grant.projectId === null || grant.spaceId === null || grant.documentUploadId === null) return null;
  return { projectId: grant.projectId, spaceId: grant.spaceId, uploadId: grant.documentUploadId };
}

/**
 * Publish one event for a target.
 * @param target - The block.
 * @param fields - The event's state and what goes with it.
 * @returns Nothing.
 * @throws {Error} When the stream rejects the entry.
 */
async function publish(target: DocumentUploadTarget, fields: Omit<DocumentUploadEvent, "type" | "docName" | "uploadId">): Promise<void> {
  await publishDocumentUploadEvent(getStreamRedis(), {
    type: "document-upload",
    docName: documentSpaceDocName(target.projectId, target.spaceId),
    uploadId: target.uploadId,
    ...fields,
  });
}

/**
 * Tell the block its bytes were handed over. Whether the upload ran out of time is the server's to settle, as on a
 * canvas node: the block reads as processing until its ending arrives.
 * @param target - The block.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceDocumentUploadProcessing(target: DocumentUploadTarget): Promise<void> {
  await publish(target, { state: "processing" });
}

/**
 * Hand the block the asset its upload resolved to; an asset that is not a picture, a video or a sound fails it.
 * @param target - The block.
 * @param asset - The registered asset.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceDocumentUploadAsset(
  target: DocumentUploadTarget,
  asset: Pick<StudioAssetEntity, "fileUrl" | "width" | "height"> & { kind: string },
): Promise<void> {
  if (!MEDIA_KINDS.has(asset.kind)) {
    await publish(target, { state: "failed", reason: "unsupported_type" });
    return;
  }
  await publish(target, {
    state: "completed",
    result: {
      url: asset.fileUrl,
      ...(asset.width !== null && asset.height !== null && { mediaWidth: asset.width, mediaHeight: asset.height }),
    },
  });
}

/**
 * Tell the block its upload failed.
 * @param target - The block.
 * @param failureReason - What the grant recorded as the cause, in its stored form.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceDocumentUploadFailure(target: DocumentUploadTarget, failureReason: string | null): Promise<void> {
  const reason = readTaskFailure(failureReason).reason ?? undefined;
  await publish(target, { state: "failed", ...(reason !== undefined && { reason }) });
}
