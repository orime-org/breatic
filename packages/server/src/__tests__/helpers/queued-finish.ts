// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Running the finish the upload route queued, the way the worker does
 * (inner#1367 §4.2a), for integration tests that drive the route.
 */

import { createQueue } from "@breatic/core";
import {
  uploadFinishService,
  UPLOAD_FINISH_QUEUE,
  type UploadFinishJob,
  type UploadFinishResult,
} from "@breatic/domain";

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * Run the finish queued for `storageKey` and take its job off the queue, so a
 * later finish of the same key queues afresh.
 * @param storageKey - The upload's key, which is the job's id.
 * @returns How it ended.
 * @throws {Error} When no finish is queued for the key, or the finish threw.
 */
export async function runQueuedFinish(storageKey: string): Promise<UploadFinishResult> {
  queue ??= createQueue(UPLOAD_FINISH_QUEUE);
  const job = await queue.getJob(storageKey);
  if (job === undefined) throw new Error(`no finish queued for ${storageKey}`);
  try {
    return await uploadFinishService.finishUpload(job.data as UploadFinishJob);
  } finally {
    await job.remove();
  }
}

/**
 * Close the queue the helper opened.
 * @returns Nothing once it is closed.
 */
export async function closeFinishQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
