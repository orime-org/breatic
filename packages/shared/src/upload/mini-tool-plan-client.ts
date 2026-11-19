// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { UntilDeadline } from "@shared/http/deadline.js";
import { askWorker, UploadHttpError } from "@shared/upload/ingest-client.js";
import {
  miniToolPlanJobRequestSchema, readMiniToolPlanJobReport,
  type MiniToolPlanJobReport, type MiniToolPlanJobRequest,
} from "@shared/upload/mini-tool-plan-job.js";

/**
 * Submit one frozen indexed plan without allocating a new upstream identity.
 * @param baseUrl - The ingest Worker's configured address.
 * @param secret - The internal credential shared with that Worker.
 * @param job - The exact persisted inputs, output keys, recipes and original deadline.
 * @param bound - The caller's original task lifetime passed unchanged to shared HTTP.
 * @returns The validated report, including any actual failed-job output subset.
 * @throws {UploadHttpError} When the Worker refuses the submission.
 * @throws {Error} When the request, response or transport is invalid.
 */
export async function submitMiniToolPlanJob(
  baseUrl: string, secret: string, job: MiniToolPlanJobRequest, bound?: UntilDeadline,
): Promise<MiniToolPlanJobReport> {
  const request = miniToolPlanJobRequestSchema.parse(job);
  const answer = await askWorker<unknown>(`${baseUrl}/jobs`, {
    method: "POST", headers: { "x-ingest-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(request),
  }, { replaySafe: true, ...(bound !== undefined && { bound }) });
  return readMiniToolPlanJobReport(request, answer);
}

/**
 * Read an existing plan's report against its original index and key capabilities.
 * @param baseUrl - The ingest Worker's configured address.
 * @param secret - The internal credential shared with that Worker.
 * @param job - The complete frozen request used to validate returned output identities.
 * @param bound - The caller's read lifetime, including settlement reads after computation ends.
 * @returns The actual report, or null only when this class has no such job.
 * @throws {UploadHttpError} When the Worker refuses for any reason other than HTTP404.
 * @throws {Error} When the request, response or transport is invalid.
 */
export async function readMiniToolPlanJob(
  baseUrl: string, secret: string, job: MiniToolPlanJobRequest, bound?: UntilDeadline,
): Promise<MiniToolPlanJobReport | null> {
  const request = miniToolPlanJobRequestSchema.parse(job);
  try {
    const answer = await askWorker<unknown>(`${baseUrl}/jobs/${encodeURIComponent(request.containerClass)}/${encodeURIComponent(request.jobId)}`, {
      method: "GET", headers: { "x-ingest-secret": secret },
    }, { replaySafe: true, ...(bound !== undefined && { bound }) });
    return readMiniToolPlanJobReport(request, answer);
  } catch (error) {
    if (error instanceof UploadHttpError && error.status === 404) return null;
    throw error;
  }
}
