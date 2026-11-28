// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Announcing an upload into a Space placeholder: a Document body block (breatic#1574) or a Timeline upload clip
 * (inner#1709).
 *
 * The placeholder lives in its Space's Yjs document, so the backend publishes and collab writes, the way a canvas
 * node receives its upload (`settleUploadTask`, `settleDedupHit`). The grant records which Space type the page named,
 * and that alone picks the event type and the document name. An event carrying the ending is the only way the ending
 * reaches the placeholder, so failing to publish it throws: an upload finish job runs again, an address fetch job
 * (one attempt) fails, and a request (a dedup hit, or a fetch or finish that could not be queued) fails and leaves
 * the page to show the failure; the `processing` event only shows the wait to the other members, and its loss is the
 * caller's to log.
 */

import { getStreamRedis, publishSpaceUploadEvent } from "@breatic/core";
import {
  DOCUMENT_MEDIA_BLOCK_TYPES,
  documentSpaceDocName,
  readTaskFailure,
  timelineSpaceDocName,
  type StudioAssetEntity,
  type TaskFailureReason,
} from "@breatic/shared";
import type { TimelineUploadResult } from "@breatic/shared/space-content";
import type { SpaceUploadTarget, UploadGrant } from "@domain/asset/upload-grant.repo.js";

/** Where a Space upload's result goes. */
export interface SpaceUploadDestination {
  target: SpaceUploadTarget;
  projectId: string;
  spaceId: string;
  uploadId: string;
}

/** The registered asset fields an announcement reads. */
type AnnouncedAsset = Pick<StudioAssetEntity, "id" | "fileUrl" | "mimeType" | "width" | "height" | "durationSeconds"> & { kind: string };

// An asset's kind names the block or clip it lands as; the same three for both Space types.
const MEDIA_KINDS: ReadonlySet<string> = new Set(DOCUMENT_MEDIA_BLOCK_TYPES);

/**
 * The Space placeholder a grant's bytes land in, when it names one.
 * @param grant - The upload's grant.
 * @returns The destination, or null for an upload with no placeholder.
 */
export function spaceUploadTargetOf(
  grant: Pick<UploadGrant, "projectId" | "spaceId" | "spaceUploadId" | "spaceUploadTarget">,
): SpaceUploadDestination | null {
  if (grant.projectId === null || grant.spaceId === null || grant.spaceUploadId === null || grant.spaceUploadTarget === null) {
    return null;
  }
  return { target: grant.spaceUploadTarget, projectId: grant.projectId, spaceId: grant.spaceId, uploadId: grant.spaceUploadId };
}

/** One event's state and what goes with it, before the destination names its type and document. */
type Announcement =
  | { state: "processing" }
  | { state: "completed"; asset: AnnouncedAsset; coverUrl: string | null }
  | { state: "failed"; reason?: TaskFailureReason };

/**
 * Publish one event for a destination, as the event type and document its Space type reads.
 * @param to - The placeholder.
 * @param what - The state and what goes with it.
 * @returns Nothing.
 * @throws {Error} When the stream rejects the entry.
 */
async function publish(to: SpaceUploadDestination, what: Announcement): Promise<void> {
  const { asset, coverUrl, ...fields } = what.state === "completed" ? what : { ...what, asset: null, coverUrl: null };
  if (to.target === "document") {
    await publishSpaceUploadEvent(getStreamRedis(), {
      type: "document-upload",
      docName: documentSpaceDocName(to.projectId, to.spaceId),
      uploadId: to.uploadId,
      ...fields,
      ...(asset !== null && {
        result: {
          url: asset.fileUrl,
          ...(asset.width !== null && asset.height !== null && { mediaWidth: asset.width, mediaHeight: asset.height }),
        },
      }),
    });
    return;
  }
  await publishSpaceUploadEvent(getStreamRedis(), {
    type: "timeline-upload",
    docName: timelineSpaceDocName(to.projectId, to.spaceId),
    uploadId: to.uploadId,
    ...fields,
    ...(asset !== null && {
      // Its address and media facts, as the upload's own result carries them (inner#2171, `settledUploadStatus`).
      result: {
        // Only a medium is announced as completed (`announceSpaceUploadAsset`).
        kind: asset.kind as TimelineUploadResult["kind"],
        url: asset.fileUrl,
        coverUrl,
        mimeType: asset.mimeType,
        durationSeconds: asset.durationSeconds,
        width: asset.width,
        height: asset.height,
      },
    }),
  });
}

/**
 * Tell the placeholder its bytes were handed over. Whether the upload ran out of time is the server's to settle, as on
 * a canvas node: the placeholder reads as processing until its ending arrives.
 * @param to - The placeholder.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceSpaceUploadProcessing(to: SpaceUploadDestination): Promise<void> {
  await publish(to, { state: "processing" });
}

/**
 * Hand the placeholder the asset its upload resolved to; an asset that is not a picture, a video or a sound fails it.
 * @param to - The placeholder.
 * @param asset - The registered asset.
 * @param coverUrl - The video's cover address the caller read with `findCoverUrlOf`, or null.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceSpaceUploadAsset(to: SpaceUploadDestination, asset: AnnouncedAsset, coverUrl: string | null = null): Promise<void> {
  if (!MEDIA_KINDS.has(asset.kind)) {
    await publish(to, { state: "failed", reason: "unsupported_type" });
    return;
  }
  await publish(to, { state: "completed", asset, coverUrl });
}

/**
 * Tell the placeholder its upload failed.
 * @param to - The placeholder.
 * @param failureReason - What the grant recorded as the cause, in its stored form.
 * @returns Nothing.
 * @throws {Error} When publishing fails.
 */
export async function announceSpaceUploadFailure(to: SpaceUploadDestination, failureReason: string | null): Promise<void> {
  const reason = readTaskFailure(failureReason).reason ?? undefined;
  await publish(to, { state: "failed", ...(reason !== undefined && { reason }) });
}
