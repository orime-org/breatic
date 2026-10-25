// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { verifyLongMediaJobRequest, type LongMediaJobRequest } from "@breatic/shared";

import { fromOurBackend } from "@ingest/backend-secret.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import type {
  LongMediaContainer,
  LongMediaEnv,
} from "@ingest/jobs/long-media-container.js";

/** The namespace and secret required by long media job routes. */
export interface LongMediaRoutesEnv extends LongMediaEnv {
  INGEST_SHARED_SECRET: string;
  LONG_MEDIA: DurableObjectNamespace<LongMediaContainer>;
}

/** `/long-media/jobs/{id}`. */
export const LONG_MEDIA_JOB_PATH = /^\/long-media\/jobs\/([^/]+)$/;

/**
 * Accept a validated long media job or return its existing durable state.
 * @param request - The backend request.
 * @param env - The Worker's bindings.
 * @returns 202 for a new job, 200 for a replay, 400 for an invalid request,
 *   401 without the backend secret, 409 for an id conflict, and 410 after expiry.
 */
export async function submitLongMediaJob(request: Request, env: LongMediaRoutesEnv): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  let job: LongMediaJobRequest;
  try {
    job = await verifyLongMediaJobRequest(await request.json());
  } catch {
    return new Response("Invalid long media job", { status: 400 });
  }

  try {
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(job.jobId));
    const result = await stub.submit(job);
    if (result.kind === "conflict") return new Response("Long media job id conflict", { status: 409 });
    if (result.kind === "expired") return new Response("Long media job expired", { status: 410 });
    return Response.json(result.snapshot, { status: result.kind === "replayed" ? 200 : 202 });
  } catch (err) {
    noteFailure("ingest_long_media_submit_failed", { jobId: job.jobId }, err);
    throw err;
  }
}

/**
 * Read a job held by this Worker's Durable Object.
 * @param request - The backend request.
 * @param env - The Worker's bindings.
 * @param jobId - The URL-encoded job id.
 * @returns 200 with the job, 401 without the secret, or 404 when absent.
 */
export async function readLongMediaJob(request: Request, env: LongMediaRoutesEnv, jobId: string): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  let decodedJobId: string;
  try {
    decodedJobId = decodeURIComponent(jobId);
  } catch {
    return new Response("No such job", { status: 404 });
  }
  const report = await env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(decodedJobId)).report();
  return report === null ? new Response("No such job", { status: 404 }) : Response.json(report);
}
