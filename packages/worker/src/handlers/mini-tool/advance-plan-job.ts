// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { env, getMiniToolsConfig, logger } from "@breatic/core";
import {
  assertBeforeDeadline, DEFAULT_TIMEOUT_MS, untilDeadline, untilDeadlineIfAhead,
  miniToolPlanJobRequestSchema, readMiniToolPlanJob, submitMiniToolPlanJob,
  EmptyBody, HttpRetryError, UploadHttpError,
  type MiniToolPlanJobReport, type MiniToolPlanJobRequest,
} from "@breatic/shared";
import { StillRunning } from "@worker/providers/still-running.js";

/** A terminal report retains the successful indexed subset even when computation failed. */
export type EndedMiniToolPlanJob = Extract<MiniToolPlanJobReport, { state: "done" | "failed" }>;

/**
 * The end of a planned job's reporting window: two polls past its deadline, the last instant a job ingest still holds can
 * be read; a job it does not hold by then was never submitted.
 * @param deadlineAt - The job's deadline.
 * @returns The window's end, in epoch ms.
 * @throws {never} Never.
 */
export function planReportingEnd(deadlineAt: number): number {
  return deadlineAt + 2 * getMiniToolsConfig().poll_interval_ms;
}

/**
 * The bound of a read of what already exists (a run's frozen ledger): the reporting window, or once it has closed the
 * transport's own bound, since reading what is stored starts no new work (as `untilDeadlineIfAhead` does for a report read).
 * @param deadlineAt - The task deadline.
 * @param now - The clock now, in epoch ms.
 * @returns The read's absolute deadline, in epoch ms.
 * @throws {never} Never.
 */
export function planReadUntil(deadlineAt: number, now: number = Date.now()): number {
  const reportingEnd = planReportingEnd(deadlineAt);
  return now < reportingEnd ? reportingEnd : now + DEFAULT_TIMEOUT_MS;
}

/**
 * Distinguish a transport interruption from a completed malformed or refused answer.
 * @param error - The original shared client's exception.
 * @returns Whether another pickup may read the same durable job again.
 * @throws {never} This classification performs no IO.
 */
function isTransientPlanTransport(error: unknown): boolean {
  if (error instanceof UploadHttpError) return error.status === 429 || (error.status >= 500 && error.status <= 599);
  if (error instanceof EmptyBody) return false;
  return error instanceof TypeError || error instanceof HttpRetryError ||
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"));
}

/**
 * Preserve the original diagnostic before enforcing this call's unchanged budget.
 * @param error - The original transport or contract failure.
 * @param request - The persisted identity used by that call.
 * @param phase - Whether this was a read or a new submission.
 * @param expiresAt - The reporting boundary for reads, original deadline for submissions.
 * @param poll - The configured delay before the next pickup.
 * @throws {DeadlinePassed} When this call's original budget has elapsed.
 * @throws {StillRunning} When a transport interruption can be retried within that budget.
 * @throws {Error} When a permanent response, contract or program failure must reach the caller.
 */
function rethrowPlanFailure(error: unknown, request: MiniToolPlanJobRequest, phase: "read" | "submit", expiresAt: number, poll: number): never {
  logger.error({ err: error, ctx: { jobId: request.jobId, containerClass: request.containerClass, phase } }, "mini_tool_plan_request_failed");
  assertBeforeDeadline(expiresAt);
  if (!isTransientPlanTransport(error)) throw error;
  throw new StillRunning(Date.now() + poll);
}

/**
 * Advance one already persisted media job without changing its original identity.
 * @param request - The complete request frozen together with its expense before external IO.
 * @returns The validated terminal report, including actual usage and any failed output subset.
 * @throws {StillRunning} When the original job is pending or its transport is temporarily unavailable.
 * @throws {DeadlinePassed} When no new submission or further wait fits its original budget.
 * @throws {Error} When the request, permanent response or report contract is invalid.
 */
export async function advanceMiniToolPlanJob(request: MiniToolPlanJobRequest): Promise<EndedMiniToolPlanJob> {
  const job = miniToolPlanJobRequestSchema.parse(request);
  const poll = getMiniToolsConfig().poll_interval_ms;
  const reportingEnd = planReportingEnd(job.deadlineAt);
  let report: MiniToolPlanJobReport | null;
  try {
    report = await readMiniToolPlanJob(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, job, untilDeadlineIfAhead(reportingEnd));
  } catch (error) {
    rethrowPlanFailure(error, job, "read", reportingEnd, poll);
  }
  if (report === null) {
    // An absent answer can arrive after the GET's start time; the report window
    // never authorizes starting work after its original computation deadline.
    const submissionBound = untilDeadline(job.deadlineAt);
    try {
      report = await submitMiniToolPlanJob(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, job, submissionBound);
    } catch (error) {
      rethrowPlanFailure(error, job, "submit", job.deadlineAt, poll);
    }
  }
  if (report.state === "done" || report.state === "failed") return report;
  assertBeforeDeadline(reportingEnd);
  throw new StillRunning(Date.now() + poll);
}
