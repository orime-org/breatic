// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Lifting a video's first frame and filing it as a cover (#1824 / #181 lane ②).
 *
 * Two callers want this: the job that follows a browser upload, and the step
 * that follows a generation. They differ in what they do with the answer — one
 * points the video's ledger row at the cover, the other only pins a url on the
 * node — and in nothing else, so the sequence itself lives here once.
 *
 * The frame is a buffer we are holding, so it reaches R2 the way every other
 * asset does: through the ingest Worker, which hashes what landed and hands
 * back the row the report filed. A cover failure never fails the video, so
 * every step here answers with `undefined` rather than throwing.
 */

import { logger } from "@breatic/core";
import { backendUploadService } from "@breatic/domain";

/** Where a cover came from and what it should be filed against. */
export interface StoreCoverContext {
  /** Project the video belongs to; it decides the owner studio. */
  projectId: string;
  /** Who the cover is attributed to. */
  actingUserId: string;
  /** The generation that produced the video, when one did. */
  generationTaskId?: string;
  /** What a warning should name, so an operator can find the video. */
  log: Record<string, unknown>;
}

/** A cover that reached the ledger. */
export interface StoredCover {
  /** The row it landed on, which a caller may point the video at. */
  assetId: string | null | undefined;
  /** Where the stored object is readable. */
  fileUrl: string;
}

/**
 * Lift the first frame of a video and file it as this studio's cover asset.
 * @param videoUrl - The video to take the frame from.
 * @param ctx - Who it belongs to and what a warning should name.
 * @returns The filed cover, or undefined when there is none to show.
 */
export async function storeCover(
  videoUrl: string,
  ctx: StoreCoverContext,
): Promise<StoredCover | undefined> {
  const { extractVideoCover } = await import(
    "@worker/providers/video-cover.js"
  );
  const cover = await extractVideoCover(videoUrl);
  if (!cover) {
    logger.warn(
      { ...ctx.log, videoUrl },
      "video_cover_extraction_returned_empty_non_fatal",
    );
    return undefined;
  }

  try {
    const stored = await backendUploadService.uploadBytesToStorage(
      new Blob([cover.png]),
      {
        projectId: ctx.projectId,
        actingUserId: ctx.actingUserId,
        ...(ctx.generationTaskId !== undefined && {
          generationTaskId: ctx.generationTaskId,
        }),
        assetSource: "cover",
        taskType: "video",
        ext: "_cover.png",
        // The mime comes from the cover itself (it owns its format, §8 PNG)
        // so the stored object and the ledger row cannot drift.
        contentType: cover.mimeType,
      },
    );
    return { assetId: stored.assetId, fileUrl: stored.fileUrl };
  } catch (err) {
    // No row means no cover anyone may serve. The video keeps its own
    // registration, so this degrades to a video without a cover.
    logger.warn({ ...ctx.log, err }, "video_cover_register_failed_non_fatal");
    return undefined;
  }
}
