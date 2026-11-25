// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What every pickup of a web-animation execution does, whatever container job it runs (inner#1711 design §5.3; #1490
 * design §6): take the row with a new attempt, read back the job its steps fixed, wait for its report until the report
 * grace past the deadline, settle only an ended report, re-check the job lock before each write, and charge actual use once.
 */

import type { Job } from "bullmq";
import { db, getWorkerConfig, logger, timelineReportGraceMs } from "@breatic/core";
import { creditLotService, runningSlotService, sumCreditsByOperationKeys, timelineOperationKey, toChargeCredits, timelineExecutionRepo, type TimelineExecutionJobData } from "@breatic/domain";
import type { TimelineExecution } from "@breatic/shared";
import { settleChargeLogged } from "@worker/handlers/settle-charge.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { move } from "@worker/handlers/timeline/timeline-transition.js";

/** A pickup's hold on its execution. */
export interface Held {
  job: Pick<Job<TimelineExecutionJobData>, "extendLock">;
  token: string | undefined;
  row: TimelineExecution;
}

/** The states a container job's report ends in. */
type EndedState = "done" | "failed" | "cancelled" | "expired" | "cancelled_before_submit";

const ENDED_STATES: ReadonlySet<string> = new Set<EndedState>(["done", "failed", "cancelled", "expired", "cancelled_before_submit"]);

/** A report that ended; only these settle. */
export type Ended<R extends { state: string }> = R & { state: EndedState };

/**
 * Whether a container job's report ended.
 * @param report - The report.
 * @returns True for a terminal state.
 * @throws {never} Never.
 */
export function ended<R extends { state: string }>(report: R): report is Ended<R> {
  return ENDED_STATES.has(report.state);
}

/** A job request's schema, as `storedStep` reads it. */
type RequestSchema<R> = { safeParse(value: unknown): { success: true; data: R } | { success: false } };

/**
 * The job step of a kind a row already holds. Its request is read back through its schema, which also restores the
 * field order jsonb does not keep, so every attempt submits the same bytes. Anything else a stored step carries beside
 * its request is ignored.
 * @param steps - The row's steps.
 * @param kind - The step's kind.
 * @param schema - The request's schema.
 * @returns The step, or undefined when none was written yet or it no longer reads.
 * @throws {never} Never.
 */
export function storedStep<K extends string, R>(
  steps: unknown[],
  kind: K,
  schema: RequestSchema<R>,
): { kind: K; request: R } | undefined {
  for (const step of steps) {
    const candidate = step as { kind?: unknown; request?: unknown } | null;
    if (candidate?.kind !== kind) continue;
    const request = schema.safeParse(candidate.request);
    return request.success ? { kind, request: request.data } : undefined;
  }
  return undefined;
}

/**
 * When a job's last report is due: the report grace past its deadline, the same grace the running-task count holds it.
 * @param deadlineAt - The job's deadline, epoch ms.
 * @returns The time, epoch ms.
 * @throws {Error} When the Timeline configuration cannot be read.
 */
export function endsAtOf(deadlineAt: number): number {
  return deadlineAt + timelineReportGraceMs();
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
 * Take the row for this pickup: claim a queued one through the running-task gate, retry a running one, keep a
 * cancelling one as it is. Every kind (create, modify, export) is taken here, so every kind passes the gate.
 * @param row - The row as read.
 * @returns The row this pickup holds, or null when there is nothing for it to do.
 * @throws {StillRunning} While its person runs as many tasks as their limit; the job goes back to the queue.
 * @throws {Error} When a write fails.
 */
export async function take(row: TimelineExecution): Promise<TimelineExecution | null> {
  if (row.status === "queued") {
    // Never claimed, so never submitted: past its deadline it ends without a job. One that waited for a running slot
    // has no deadline until it starts (inner#1968).
    if (row.slotWaitSince == null && Date.parse(row.deadlineAt) <= Date.now()) {
      await move(row, { type: "deadline" });
      return null;
    }
    // Its spend was judged once, at its acceptance; waiting for a slot does not judge it again (inner#1968). A row
    // another pickup claimed first answers ended, and is read again and taken as it stands.
    let gate: Awaited<ReturnType<typeof runningSlotService.claimWithinLimit>>;
    try {
      gate = await runningSlotService.claimWithinLimit(row.id);
    } catch (err) {
      if (err instanceof StillRunning) {
        for (const failure of err.publishFailures) logger.error({ err: failure, executionId: row.id }, "running_slot_publish_failed");
      }
      throw err;
    }
    for (const err of gate.publishFailures) logger.error({ err, executionId: row.id }, "running_slot_publish_failed");
    if (gate.outcome === "started") return gate.started;
    const after = await timelineExecutionRepo.findById(row.id);
    return after === undefined ? null : take(after);
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
