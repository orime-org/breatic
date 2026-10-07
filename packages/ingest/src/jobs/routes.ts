// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two job endpoints (inner#888 §8.1). Only our worker calls them: both
 * take the shared secret. A job lives in the object its class's namespace
 * names after the job id, so submitting the same id again reaches the same
 * object, and reading names the class the job was submitted to.
 */

import { miniToolJobRequestSchema, type MiniToolJobRequest } from "@breatic/shared";

import { fromOurBackend } from "@ingest/backend-secret.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import {
  CLASS_BINDINGS,
  JobStartFailed,
  type MiniToolClass,
  type MiniToolEnv,
} from "@ingest/jobs/mini-tool-container.js";

/** What the job endpoints read. */
export type JobsEnv = MiniToolEnv & { INGEST_SHARED_SECRET: string };

/** `/jobs/<class>/<id>`. */
export const JOB_PATH = /^\/jobs\/([^/]+)\/([^/]+)$/;

/**
 * The namespace a class is bound under.
 * @param env - The bindings.
 * @param containerClass - The class a job names.
 * @returns The namespace, or null for a class this Worker does not bind.
 */
function namespaceOf(env: JobsEnv, containerClass: string): MiniToolEnv["MINI_TOOL_STD1"] | null {
  if (!Object.hasOwn(CLASS_BINDINGS, containerClass)) return null;
  // Both classes share one shape; only their instance size differs.
  return env[CLASS_BINDINGS[containerClass as MiniToolClass]] as MiniToolEnv["MINI_TOOL_STD1"];
}

/**
 * `POST /jobs` — start a job, or answer the one already holding its id.
 * @param request - The request.
 * @param env - The bindings.
 * @returns 200 with the job's report; 400 for a body that is not a job or a
 *   class this Worker does not bind; 401 without the secret; 503 when the
 *   container could not start.
 */
export async function submitJob(request: Request, env: JobsEnv): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const parsed = miniToolJobRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response("Not a job", { status: 400 });
  const job = parsed.data as MiniToolJobRequest;
  const namespace = namespaceOf(env, job.containerClass);
  if (namespace === null) return new Response("Unknown container class", { status: 400 });
  try {
    const report = await namespace.get(namespace.idFromName(job.jobId)).submit(job);
    return Response.json(report);
  } catch (err) {
    if (err instanceof JobStartFailed || (err instanceof Error && err.name === "JobStartFailed")) {
      noteFailure("ingest_mini_tool_start_failed", { jobId: job.jobId, containerClass: job.containerClass }, err);
      return new Response("The container could not start", { status: 503 });
    }
    throw err;
  }
}

/**
 * `GET /jobs/<class>/<id>` — how a job is doing.
 * @param request - The request.
 * @param env - The bindings.
 * @param containerClass - The class it was submitted to.
 * @param jobId - Its id.
 * @returns 200 with its report; 404 when that class holds no such job; 401 without the secret.
 */
export async function readJob(request: Request, env: JobsEnv, containerClass: string, jobId: string): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const namespace = namespaceOf(env, decodeURIComponent(containerClass));
  if (namespace === null) return new Response("No such job", { status: 404 });
  const report = await namespace.get(namespace.idFromName(decodeURIComponent(jobId))).report();
  return report === null ? new Response("No such job", { status: 404 }) : Response.json(report);
}
