// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing a browser upload (inner#1367 §4.2a). The route took the
 * permission to finish and queued this; what finishing does is the domain's,
 * and this writes down how it ended.
 */

import type { Job } from "bullmq";
import { logger } from "@breatic/core";
import { uploadFinishService, type UploadFinishJob } from "@breatic/domain";
import { noteSideEffects } from "@worker/handlers/side-effects.js";

/**
 * Finish one upload and log how it ended.
 * @param job - The queued finish.
 * @returns Nothing once the grant and the row are settled.
 * @throws {Error} When the ledger cannot be read or written, so the queue
 *   tries again.
 */
export async function runUploadFinish(job: Job<UploadFinishJob>): Promise<void> {
  const { storageKey, assetSource } = job.data;
  const result = await uploadFinishService.finishUpload(job.data);
  noteSideEffects(result.outcome, { key: storageKey });

  const { refused } = result;
  if (refused !== undefined) {
    if (refused.contentType !== undefined) {
      logger.info(
        { key: storageKey, contentType: refused.contentType, source: assetSource },
        "upload_purpose_type_refused",
      );
    } else {
      logger.error(
        { err: refused.cause, key: storageKey, reason: refused.reason },
        "upload_finish_failed",
      );
    }
    return;
  }
  if (result.mediaReadNotQueued !== undefined) {
    logger.error({ err: result.mediaReadNotQueued, key: storageKey }, "media_read_enqueue_failed");
  }
  const { outcome } = result;
  if (outcome.status === "rejected") {
    logger.info({ key: storageKey, reason: outcome.reason }, `ingest_report_${outcome.reason}`);
  } else {
    logger.info({ key: storageKey, status: outcome.status }, "upload_finished");
  }
}

/**
 * Settle a finish whose job ended without its handler running.
 *
 * A finish whose process went away twice is failed the next time a worker
 * picks it up, carrying the reason the queue recorded when it judged it
 * stalled. Its handler never ran that time, so this is the one place its grant
 * gets settled; without it the browser keeps asking about an upload nothing
 * will finish.
 * @param job - The failed job.
 * @returns Whether this was a stalled job, settled here.
 * @throws {Error} When settling itself fails.
 */
export async function settleStalledUploadFinish(job: Job<UploadFinishJob>): Promise<boolean> {
  if (!job.deferredFailure) return false;
  const outcome = await uploadFinishService.settleStalledFinish(job.data.storageKey);
  noteSideEffects(outcome, { key: job.data.storageKey });
  return true;
}
