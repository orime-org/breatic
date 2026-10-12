// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Settling an upload or a pasted link that ended without registering
 * (inner#1367): its grant is voided and the node's task row ends with the
 * reason given.
 */

import type { Job } from "bullmq";
import { ingestReportService } from "@breatic/domain";
import { INGEST_NO_ANSWER } from "@breatic/shared";
import { noteSideEffects } from "@worker/handlers/side-effects.js";

/**
 * Settle the grant and the node's task row on an ingest that did not finish.
 * @param storageKey - The key the grant was opened on.
 * @param reason - What the node's task list shows.
 * @returns Nothing once both are settled.
 * @throws {Error} When the ledger cannot be read or written.
 */
export async function abortIngest(storageKey: string, reason: string): Promise<void> {
  const outcome = await ingestReportService.applyIngestReport({
    storageKey,
    outcome: "aborted",
    reason,
  });
  noteSideEffects(outcome, { key: storageKey });
}

/**
 * Settle an ingest job the queue failed for having stalled.
 *
 * A job whose process went away (a deploy, a crash) past what the queue allows
 * is failed the next time a worker picks it up, carrying the reason the queue
 * recorded. Its handler never ran that time, so this is the one place its
 * grant and its row are settled.
 * @param job - The failed job.
 * @returns Whether this was a stalled job, settled here.
 * @throws {Error} When settling itself fails.
 */
export async function settleStalledIngest(job: Job<{ storageKey: string }>): Promise<boolean> {
  if (!job.deferredFailure) return false;
  await abortIngest(job.data.storageKey, INGEST_NO_ANSWER);
  return true;
}
