// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What every pickup of a web-animation execution does, whatever container job it runs (inner#1711 design §5.3; #1490
 * design §6): take the row with a new attempt, re-check the job lock before each write, and charge actual use once.
 */

import type { Job } from "bullmq";
import { db, getWorkerConfig, logger, timelineExecutionRepo, type TimelineExecutionJobData } from "@breatic/core";
import { creditLotService, sumCreditsByOperationKeys, timelineOperationKey, toChargeCredits } from "@breatic/domain";
import type { TimelineExecution } from "@breatic/shared";
import { settleChargeLogged } from "@worker/handlers/settle-charge.js";
import { move } from "@worker/handlers/timeline/timeline-transition.js";

/** A pickup's hold on its execution. */
export interface Held {
  job: Pick<Job<TimelineExecutionJobData>, "extendLock">;
  token: string | undefined;
  row: TimelineExecution;
}

/**
 * Whether this attempt still owns the job. A pickup outside the queue (no token) has no rival.
 * @param held - The pickup.
 * @returns True when it may write.
 * @throws {Error} When Redis cannot answer; the job's retry owns that.
 */
export async function owns(held: Held): Promise<boolean> {
  if (held.token === undefined) return true;
  if ((await held.job.extendLock(held.token, getWorkerConfig().lock_duration_ms)) === 1) return true;
  logger.error({ executionId: held.row.id, attempt: held.row.attempt }, "timeline_job_lock_lost_aborting");
  return false;
}

/**
 * Take the row for this pickup: claim a queued one, retry a running one, keep a cancelling one as it is.
 * @param row - The row as read.
 * @returns The row this pickup holds, or null when there is nothing for it to do.
 * @throws {Error} When a write fails.
 */
export async function take(row: TimelineExecution): Promise<TimelineExecution | null> {
  if (row.status === "queued") {
    // Never claimed, so never submitted: past its deadline it ends without a job.
    if (Date.parse(row.deadlineAt) <= Date.now()) {
      await move(row, { type: "deadline" });
      return null;
    }
    const claimed = await move(row, { type: "claim" });
    return claimed.applied ? claimed.row : take(claimed.row);
  }
  if (row.status === "running") {
    // A new attempt changes nothing the user sees, so it does not signal the Space; a phase change does.
    const retried = await timelineExecutionRepo.transition({ id: row.id, event: { type: "retry" } });
    return retried.applied ? retried.row : take(retried.row);
  }
  return row.status === "cancelling" ? row : null;
}

/**
 * Charge what the execution's rows add up to, once (inner#1617): the `billed_at` update and the charge request commit
 * together, so only the writer whose update lands records a charge, and a run that spent nothing records none. The
 * request is then settled; a settlement that fails stays pending for the worker sweep and does not stop the run from
 * ending. As with an Agent chat turn nothing was held, and the charge may take the balance below zero.
 * @param row - The execution.
 * @param charge - What the charge names.
 * @param charge.model - The model, or the service, it paid for.
 * @param charge.provider - Who served it.
 * @returns Nothing.
 * @throws {Error} When the `billed_at` update or the request cannot be written; neither then commits.
 */
export async function chargeExecution(row: TimelineExecution, charge: { model: string; provider: string }): Promise<void> {
  const sums = await sumCreditsByOperationKeys([timelineOperationKey(row.id)]);
  const amount = toChargeCredits(Number(sums.get(timelineOperationKey(row.id)) ?? 0));
  if (amount <= 0) return;
  const requestId = await db.transaction(async (tx) => {
    if (!(await timelineExecutionRepo.markBilled(row.id, String(amount), tx))) return null;
    return creditLotService.requestCharge(
      {
        kind: "timeline_execution",
        referenceId: row.id,
        actorUserId: row.actorUserId,
        projectId: row.projectId,
        amount,
        description: "timeline_web_animation",
        model: charge.model,
        provider: charge.provider,
      },
      tx,
    );
  });
  if (requestId === null) return;
  await settleChargeLogged(requestId, { executionId: row.id, userId: row.actorUserId, projectId: row.projectId, amount });
}
