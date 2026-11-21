// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ingest Worker's web-animation job routes, as the worker calls them (inner#1711 design §3.7, §6; #1490 design
 * §6.1): the creation container's jobs and an export's render jobs, each read with its own report schema.
 *
 * Each call answers a report or says why there is none: no such job (404), the container could not start (503, the
 * next pickup submits again), web-animation execution is not configured on this Worker (501, a terminal answer), or,
 * on a submit, no upstream of the job's plan has its key there (501 naming the model and the variables, terminal too).
 */

import { env } from "@breatic/core";
import { httpRequest, untilDeadlineIfAhead } from "@breatic/shared";
import {
  WEB_ANIMATION_CONTAINER_CLASS,
  WEB_ANIMATION_RENDER_CONTAINER_CLASS,
  webAnimationJobReportSchema,
  webAnimationRenderJobReportSchema,
  type WebAnimationJobCancel,
  type WebAnimationJobReport,
  type WebAnimationJobRequest,
  type WebAnimationRenderJobReport,
  type WebAnimationRenderJobRequest,
} from "@breatic/shared/space-content";

/** What the Worker answered, with the report of the job's own kind. */
export type IngestAnswer<R = WebAnimationJobReport> =
  | { kind: "report"; report: R }
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "disabled" }
  | { kind: "unconfigured"; model: string; envVars: string[] };

/** An answer the worker cannot act on. */
export class IngestJobError extends Error {
  /**
   * Name the refusal.
   * @param status - The Worker's status.
   * @param route - Which call it answered.
   */
  constructor(readonly status: number, route: string) {
    super(`The ingest Worker answered ${route} with ${status}`);
    this.name = "IngestJobError";
  }
}

/**
 * What a 501 says: the plan's upstreams have no key on the Worker, or the feature is off there.
 * @param text - The answer's body.
 * @returns The answer.
 * @throws {never} Never.
 */
function disabledAnswer(text: string): IngestAnswer<never> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // `feature_disabled` is plain text.
    return { kind: "disabled" };
  }
  const named = body as { error?: unknown; model?: unknown; envVars?: unknown } | null;
  if (named?.error !== "not_configured" || typeof named.model !== "string" || !Array.isArray(named.envVars)) return { kind: "disabled" };
  return { kind: "unconfigured", model: named.model, envVars: named.envVars.filter((name): name is string => typeof name === "string") };
}

/** Reads a job's report. */
interface ReportReader<R> { safeParse(value: unknown): { success: true; data: R } | { success: false } }

/**
 * Send one call and read what it answered.
 * @param route - Which call, for the error.
 * @param url - The endpoint.
 * @param init - Method and body.
 * @param endsAt - When the job's last report is due; calls before it are bounded by it.
 * @param reader - The report schema of the job's kind.
 * @returns The answer.
 * @throws {IngestJobError} When the Worker answers anything but a report, 404, 501 or 503, or a report this side cannot read.
 * @throws {unknown} The transport's own failure when no delivery produced a response.
 */
async function ask<R>(route: string, url: string, init: RequestInit, endsAt: number, reader: ReportReader<R>): Promise<IngestAnswer<R>> {
  const res = await httpRequest(
    url,
    { ...init, headers: { "x-ingest-secret": env.INGEST_SHARED_SECRET, "content-type": "application/json" } },
    { replaySafe: true, ...untilDeadlineIfAhead(endsAt) },
  );
  if (res.status === 404) return { kind: "missing" };
  if (res.status === 501) return disabledAnswer(await res.text().catch(() => ""));
  if (res.status === 503) return { kind: "unavailable" };
  if (!res.ok) throw new IngestJobError(res.status, route);
  const report = reader.safeParse(await res.json());
  if (!report.success) throw new IngestJobError(res.status, `${route} (unreadable report)`);
  return { kind: "report", report: report.data };
}

/** Submit, read and cancel one job class's jobs. */
interface JobCalls<Q, R> {
  /** Submit a job; submitting the same id again answers the job that holds it. */
  submit(request: Q, endsAt: number): Promise<IngestAnswer<R>>;
  /** Read a job's report. */
  read(jobId: string, endsAt: number): Promise<IngestAnswer<R>>;
  /** Ask a job to stop; with no job yet, the Worker keeps a pre-submit cancel marker until `deadlineAt`. */
  cancel(jobId: string, body: WebAnimationJobCancel, endsAt: number): Promise<IngestAnswer<R>>;
}

/**
 * The calls of one container class. A job cancelled before any submit answers its submit with 410, read here as that
 * cancel's report.
 * @param containerClass - The container class the jobs run on.
 * @param reportSchema - The report schema of the class's jobs.
 * @param cancelledBeforeSubmit - The report a 410 on submit stands for.
 * @returns The calls; each throws {@link IngestJobError} on any refusal other than those {@link IngestAnswer} names.
 * @throws {never} Never.
 */
function jobCalls<Q, R>(containerClass: string, reportSchema: ReportReader<R>, cancelledBeforeSubmit: R): JobCalls<Q, R> {
  /**
   * The address of one job.
   * @param jobId - The job.
   * @returns Its route.
   * @throws {never} Never.
   */
  const jobUrl = (jobId: string): string => `${env.INGEST_BASE_URL}/jobs/${containerClass}/${encodeURIComponent(jobId)}`;
  return {
    submit: async (request, endsAt) => {
      try {
        return await ask(`submit ${containerClass}`, `${env.INGEST_BASE_URL}/jobs`, { method: "POST", body: JSON.stringify(request) }, endsAt, reportSchema);
      } catch (err) {
        if (!(err instanceof IngestJobError && err.status === 410)) throw err;
        return { kind: "report", report: cancelledBeforeSubmit };
      }
    },
    read: (jobId, endsAt) => ask(`read ${containerClass}`, jobUrl(jobId), { method: "GET" }, endsAt, reportSchema),
    cancel: (jobId, body, endsAt) => ask(`cancel ${containerClass}`, `${jobUrl(jobId)}/cancel`, { method: "POST", body: JSON.stringify(body) }, endsAt, reportSchema),
  };
}

/** The creation container's jobs. */
export const creationJobs = jobCalls<WebAnimationJobRequest, WebAnimationJobReport>(
  WEB_ANIMATION_CONTAINER_CLASS,
  webAnimationJobReportSchema,
  { state: "cancelled_before_submit", phase: null, steps: [], calls: [], container: null, outputs: [], failureReason: null },
);

/** An export's render jobs. */
export const renderJobs = jobCalls<WebAnimationRenderJobRequest, WebAnimationRenderJobReport>(
  WEB_ANIMATION_RENDER_CONTAINER_CLASS,
  webAnimationRenderJobReportSchema,
  { state: "cancelled_before_submit", phase: null, progress: null, container: null, video: null, failureReason: null },
);
