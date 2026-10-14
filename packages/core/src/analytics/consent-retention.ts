// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The daily job that removes consent receipts which no longer count
 * (inner#1442 design §4.4.6 "保留"). Every deployment runs it, whatever it
 * sends; the deletion itself is `pruneConsentReceipts` in the account repo.
 */

import { createQueue, defaultJobOpts } from "@core/infra/queue.js";

/** The queue the daily clean-up runs on. */
export const ANALYTICS_CONSENT_QUEUE = "analytics-consent";

/** Name of the daily clean-up job. */
export const CONSENT_PRUNE_JOB = "prune";

const DAY_MS = 86_400_000;

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * Run `pruneConsentReceipts` once a day, once across all workers.
 * Registered on every deployment.
 */
export async function scheduleConsentPrune(): Promise<void> {
  queue ??= createQueue(ANALYTICS_CONSENT_QUEUE);
  const { removeOnComplete, removeOnFail } = defaultJobOpts();
  await queue.upsertJobScheduler(
    CONSENT_PRUNE_JOB,
    { every: DAY_MS },
    { name: CONSENT_PRUNE_JOB, data: {}, opts: { removeOnComplete, removeOnFail } },
  );
}
