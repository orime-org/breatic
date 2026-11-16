// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The ingest Worker's web-animation job routes, as the worker calls them (inner#1711 design §3.7, §6).
 *
 * Each call answers a report or says why there is none: no such job (404), the container could not start (503, the
 * next pickup submits again), web-animation execution is not configured on this Worker (501, a terminal answer), or,
 * on a submit, no upstream of the job's plan has its key there (501 naming the model and the variables, terminal too).
 */

import { env } from "@breatic/core";
import { httpRequest, untilDeadlineIfAhead } from "@breatic/shared";
import {
  WEB_ANIMATION_CONTAINER_CLASS,
  webAnimationJobReportSchema,
  type WebAnimationJobCancel,
  type WebAnimationJobReport,
  type WebAnimationJobRequest,
} from "@breatic/shared/space-content";

/** What the Worker answered. */
export type IngestAnswer =
  | { kind: "report"; report: WebAnimationJobReport }
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
function disabledAnswer(text: string): IngestAnswer {
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

/**
 * Send one call and read what it answered.
 * @param route - Which call, for the error.
 * @param url - The endpoint.
 * @param init - Method and body.
 * @param endsAt - When the job's last report is due; calls before it are bounded by it.
 * @returns The answer.
 * @throws {IngestJobError} When the Worker answers anything but a report, 404, 501 or 503, or a report this side cannot read.
 * @throws {unknown} The transport's own failure when no delivery produced a response.
 */
async function ask(route: string, url: string, init: RequestInit, endsAt: number): Promise<IngestAnswer> {
  const res = await httpRequest(
    url,
    { ...init, headers: { "x-ingest-secret": env.INGEST_SHARED_SECRET, "content-type": "application/json" } },
    { replaySafe: true, ...untilDeadlineIfAhead(endsAt) },
  );
  if (res.status === 404) return { kind: "missing" };
  if (res.status === 501) return disabledAnswer(await res.text().catch(() => ""));
  if (res.status === 503) return { kind: "unavailable" };
  if (!res.ok) throw new IngestJobError(res.status, route);
  const report = webAnimationJobReportSchema.safeParse(await res.json());
  if (!report.success) throw new IngestJobError(res.status, `${route} (unreadable report)`);
  return { kind: "report", report: report.data };
}

/**
 * The address of one job.
 * @param jobId - The job.
 * @returns Its route.
 * @throws {never} Never.
 */
function jobUrl(jobId: string): string {
  return `${env.INGEST_BASE_URL}/jobs/${WEB_ANIMATION_CONTAINER_CLASS}/${encodeURIComponent(jobId)}`;
}

/**
 * Submit a job; submitting the same id again answers the job that holds it. A job cancelled before any submit
 * answers 410, read here as that cancel's report.
 * @param request - The job.
 * @param endsAt - When its last report is due.
 * @returns The answer.
 * @throws {IngestJobError} On any other refusal.
 */
export async function submitWebAnimationJob(request: WebAnimationJobRequest, endsAt: number): Promise<IngestAnswer> {
  try {
    return await ask("submit", `${env.INGEST_BASE_URL}/jobs`, { method: "POST", body: JSON.stringify(request) }, endsAt);
  } catch (err) {
    if (!(err instanceof IngestJobError && err.status === 410)) throw err;
    return {
      kind: "report",
      report: { state: "cancelled_before_submit", phase: null, steps: [], calls: [], container: null, outputs: [], failureReason: null },
    };
  }
}

/**
 * Read a job's report.
 * @param jobId - The job.
 * @param endsAt - When its last report is due.
 * @returns The answer.
 * @throws {IngestJobError} On any other refusal.
 */
export async function readWebAnimationJob(jobId: string, endsAt: number): Promise<IngestAnswer> {
  return ask("read", jobUrl(jobId), { method: "GET" }, endsAt);
}

/**
 * Ask a job to stop; with no job yet, the Worker keeps a pre-submit cancel marker until `deadlineAt`.
 * @param jobId - The job.
 * @param body - The cancel body.
 * @param endsAt - When its last report is due.
 * @returns The answer.
 * @throws {IngestJobError} On any other refusal.
 */
export async function cancelWebAnimationJob(jobId: string, body: WebAnimationJobCancel, endsAt: number): Promise<IngestAnswer> {
  return ask("cancel", `${jobUrl(jobId)}/cancel`, { method: "POST", body: JSON.stringify(body) }, endsAt);
}
