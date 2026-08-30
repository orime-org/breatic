// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Extract a cover for a video that has already been uploaded (#173, design §5.3).
 *
 * The server registers the video when the ingest report arrives and then hands
 * the rest here, because extracting a frame needs ffmpeg and takes long enough
 * that no request should wait on it. What is left is everything the node has
 * not been told yet: the cover, the history row, the feed row, and the one
 * event that puts the URLs into the Yjs document.
 *
 * The node is in `handling` throughout, and only this event takes it out. That
 * is why a publish failure is thrown rather than logged — BullMQ retries the
 * job, and the queue's own failure net catches the case where the retries run
 * out. Everything upstream of the event is best-effort by comparison: the
 * video is already in the ledger, so a cover that cannot be extracted or
 * registered degrades to a video without one rather than to a failure.
 */

import {
  getStorageAdapter,
  getStreamRedis,
  logger,
  projectActivitiesRepo,
  publishActivityNew,
} from "@breatic/core";
import {
  assetService,
  assetRepo,
  nodeHistoryService,
  emitNodeStateDone,
  type VideoCoverJobData,
} from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";

/** The BullMQ job shape this handler reads. */
export interface VideoCoverJobLike {
  data: VideoCoverJobData;
}

/**
 * Extract, register and link a video's cover, then tell the node.
 * @param job - The BullMQ job carrying the registered video's identity.
 * @throws {Error} When the node write-back cannot be published, so BullMQ
 *   retries: the URL exists nowhere else until this event lands.
 */
export async function runVideoCover(job: VideoCoverJobLike): Promise<void> {
  const data = job.data;
  const adapter = await getStorageAdapter();
  const coverUrl = await resolveCover(data, adapter.publicUrl.bind(adapter));

  // Written before the event so a publish failure retries into a history row
  // that already exists — the key makes the second write return the first.
  const recorded = await nodeHistoryService.recordUpload({
    projectId: data.projectId,
    nodeId: data.nodeId,
    userId: data.userId,
    content: data.videoUrl,
    ...(coverUrl !== undefined && { thumbnailUrl: coverUrl }),
    storageKey: data.storageKey,
    metadata: {
      ...(data.filename !== null && { filename: data.filename }),
      size: data.sizeBytes,
      mimeType: data.mimeType,
    },
  });

  // The feed has no idempotency key of its own, so it follows the history row:
  // a replay that found the row already there adds nothing here either.
  if (recorded.inserted) {
    await recordFeedRow(data, coverUrl);
  }

  await emitNodeStateDone(
    getStreamRedis(),
    canvasSpaceDocName(data.projectId, data.spaceId),
    data.nodeId,
    { content: data.videoUrl, ...(coverUrl !== undefined && { coverUrl }) },
    data.leaseGen,
  );
}

/**
 * Produce the cover and return the URL the node should pin, or undefined when
 * there is no cover to show.
 *
 * The URL comes from the REGISTERED row, never from the object the extractor
 * just stored: within one studio the same frame dedups to a single row, so a
 * second video with an identical first frame resolves to a row holding a
 * different key. Pinning the fresh key would point the node at the object the
 * offline reclaim job is about to remove.
 * @param data - The job payload.
 * @param publicUrl - Resolves a storage key to its canonical URL.
 * @returns The cover's canonical URL, or undefined when there is none.
 */
async function resolveCover(
  data: VideoCoverJobData,
  publicUrl: (key: string) => string,
): Promise<string | undefined> {
  const { extractVideoCover } = await import(
    "@worker/providers/video-cover.js"
  );
  const cover = await extractVideoCover(data.videoUrl);
  if (!cover) {
    logger.warn(
      { storageKey: data.storageKey, videoUrl: data.videoUrl },
      "video_cover_extraction_returned_empty_non_fatal",
    );
    return undefined;
  }

  try {
    const { asset, reclaimQueueFailed } = await assetService.register({
      projectId: data.projectId,
      actingUserId: data.userId,
      ownerStudioId: data.ownerStudioId,
      contentHash: cover.sha256,
      storageKey: cover.key,
      fileUrl: cover.url,
      sizeBytes: cover.sizeBytes,
      mimeType: cover.mimeType,
      kind: "image",
      source: "cover",
    });
    if (reclaimQueueFailed === true) {
      // The registration succeeded and only the bookkeeping insert that hands
      // the now-redundant object to the offline reclaim job failed. The
      // library layer may not log, so it returns a flag; swallowing it would
      // leave the object silently absent from that job's work list.
      logger.warn(
        { storageKey: data.storageKey, key: cover.key, hash: cover.sha256 },
        "asset_reclaim_queue_failed",
      );
    }
    await assetRepo.setCoverAsset(data.videoAssetId, asset.id);
    return publicUrl(asset.storageKey);
  } catch (err) {
    // No live row means no cover anyone may serve. The video keeps its own
    // registration, so this degrades to a video without a cover.
    logger.warn(
      { err, storageKey: data.storageKey },
      "video_cover_register_failed_non_fatal",
    );
    return undefined;
  }
}

/**
 * Announce the upload on the project's activity feed.
 * @param data - The job payload.
 * @param coverUrl - The cover's canonical URL, when there is one.
 */
async function recordFeedRow(
  data: VideoCoverJobData,
  coverUrl: string | undefined,
): Promise<void> {
  try {
    await projectActivitiesRepo.insert({
      projectId: data.projectId,
      actorUserId: data.userId,
      type: data.source === "mini_tool" ? "generation:succeeded" : "asset:uploaded",
      spaceId: data.spaceId,
      nodeId: data.nodeId,
      payload:
        data.source === "mini_tool"
          ? {
              source: "mini_tool",
              ...(data.toolName !== null && { toolName: data.toolName }),
              executedOn: "frontend",
              fileUrl: data.videoUrl,
              kind: "video",
              ...(coverUrl !== undefined && { thumbnailUrl: coverUrl }),
            }
          : {
              fileUrl: data.videoUrl,
              kind: "video",
              ...(coverUrl !== undefined && { thumbnailUrl: coverUrl }),
            },
    });
    await publishActivityNew(data.projectId);
  } catch (err) {
    // The feed is a record of what happened, not something the node waits on.
    // Failing the job here would replay the whole extraction for a row nobody
    // is blocked by.
    logger.warn(
      { err, projectId: data.projectId, storageKey: data.storageKey },
      "activity_record_failed",
    );
  }
}
