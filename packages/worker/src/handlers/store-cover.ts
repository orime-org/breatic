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
 * back the row the report filed.
 *
 * Loading the extractor and running it can throw — the module statically
 * imports Sharp — and each caller decides what that means for it: a generation
 * degrades the output to Film, while an upload's own job lets it fail so BullMQ
 * delivers again. Everything after that answers with `undefined`.
 */

import { logger } from "@breatic/core";
import { httpRequest } from "@breatic/shared";
import { storeBytes } from "@worker/handlers/backend-upload.js";

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
 * How long to wait on the question "is this object there", in ms.
 *
 * A HEAD returns headers alone, so this covers reaching the edge rather than
 * moving the video. Bounded because the answer is only worth having while this
 * delivery still holds its slot.
 */
const SOURCE_PROBE_TIMEOUT_MS = 10_000;

/**
 * Whether the video can be read at the url the extractor was handed.
 *
 * Asked only after nothing came out, and it is what separates the two things
 * that end that way: a video holding no decodable frame, which stays that way
 * however many times it is tried, and an object the edge has not made readable
 * yet, which the next delivery finds. Anything other than a reply saying the
 * object is there — a 404, a 5xx, a connection that never opened — counts as
 * not readable, because none of them is evidence that it is.
 * @param videoUrl - The url the extractor was given.
 * @returns True when the object answers as present.
 */
async function sourceIsReadable(videoUrl: string): Promise<boolean> {
  try {
    // A HEAD changes nothing, so the transport is free to deliver it again —
    // which is what keeps a single dropped connection from being read as an
    // object that is not there.
    const response = await httpRequest(
      videoUrl,
      { method: "HEAD" },
      { replaySafe: true, timeoutMs: SOURCE_PROBE_TIMEOUT_MS },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Lift the first frame of a video and file it as this studio's cover asset.
 * @param videoUrl - The video to take the frame from.
 * @param ctx - Who it belongs to and what a warning should name.
 * @returns The filed cover, or undefined when there is none to show.
 * @throws {Error} When the video is not readable at that url yet, so the
 *   caller's own retry policy gets to try again.
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
    if (!(await sourceIsReadable(videoUrl))) {
      // The bytes reached R2 before this job was enqueued, so an object that
      // does not answer is one the edge is still catching up on. Thrown
      // rather than degraded: the upload's job has attempts left and the next
      // one finds it, while a generation catches this and goes on without a
      // cover. Nothing has been stored at this point, so a repeat delivery
      // leaves nothing behind.
      throw new Error(`Video is not readable yet at ${videoUrl}`);
    }
    logger.warn(
      { ...ctx.log, videoUrl },
      "video_cover_extraction_returned_empty_non_fatal",
    );
    return undefined;
  }

  try {
    const stored = await storeBytes(
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
