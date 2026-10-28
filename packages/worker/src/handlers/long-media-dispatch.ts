// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Queue } from "bullmq";
import {
  defaultJobOpts,
  getUnderstandConfig,
  getWorkerConfig,
  logger,
} from "@breatic/core";
import {
  applyUnderstandDispatchEvent,
  listDueUnderstandDispatches,
} from "@breatic/domain";

/** The durable operation wake consumed by the long-media executor. */
export interface LongMediaOperationJob {
  operationId: string;
  wakeSequence: number;
}

/** Queue holding durable long-media operation wakes. */
export const LONG_MEDIA_OPERATIONS_QUEUE = "long-media-operations";

/** Queue holding the recurring SQL outbox scan. */
export const LONG_MEDIA_DISPATCH_QUEUE = "long-media-dispatch";

/**
 * Deliver due operation wakes using stable BullMQ IDs and persist delivery outcomes.
 * @param queue - The queue that receives long-media operation jobs.
 * @returns Number of SQL candidates successfully delivered to BullMQ.
 */
export async function runLongMediaDispatchSweep(
  queue: Pick<Queue<LongMediaOperationJob>, "add" | "getJob">,
): Promise<number> {
  const batchSize = getUnderstandConfig().long_media.delivery_concurrency;
  const due = await listDueUnderstandDispatches(batchSize);
  let delivered = 0;

  for (const wake of due) {
    const jobId = `lm_${wake.operationId}_${wake.sequence}`;
    try {
      const existing = await queue.getJob(jobId);
      if (existing && await existing.isFailed()) await existing.remove();
      await queue.add(
        "long-media-operation",
        { operationId: wake.operationId, wakeSequence: wake.sequence },
        { ...defaultJobOpts(), jobId },
      );
      delivered += 1;
    } catch (err) {
      logger.error({ err, operationId: wake.operationId, wakeSequence: wake.sequence }, "long_media_dispatch_send_failed");
      try {
        await applyUnderstandDispatchEvent(wake.operationId, {
          type: "send-failure",
          expectedRevision: wake.revision,
          retryAtMs: Date.now() + getWorkerConfig().poll_interval,
        });
      } catch (recordError) {
        logger.error({ err: recordError, operationId: wake.operationId, wakeSequence: wake.sequence }, "long_media_dispatch_failure_record_failed");
      }
      continue;
    }

    try {
      await applyUnderstandDispatchEvent(wake.operationId, {
        type: "dispatch",
        expectedRevision: wake.revision,
        operationId: wake.operationId,
        atMs: Date.now(),
      });
    } catch (err) {
      logger.error({ err, operationId: wake.operationId, wakeSequence: wake.sequence }, "long_media_dispatch_receipt_failed");
    }
  }
  return delivered;
}
