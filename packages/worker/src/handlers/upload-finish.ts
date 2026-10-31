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
    } else if (refused.reason === "unsupported_type") {
      // The Worker's 415: the bytes the person sent are a kind we do not
      // take, which the Worker itself files as the sender's input.
      logger.info({ key: storageKey, source: assetSource }, "upload_stored_type_refused");
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
