// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two job endpoints (inner#888 §8.1). Only our worker calls them: both
 * take the shared secret. A job lives in the object its class's namespace
 * names after the job id, so submitting the same id again reaches the same
 * object, and reading names the class the job was submitted to.
 */

import { miniToolJobRequestSchema, miniToolPlanJobRequestSchema } from "@breatic/shared";

import { fromOurBackend } from "@ingest/backend-secret.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import {
  CLASS_BINDINGS,
  JobStartFailed,
  JobIdentityConflict,
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
  // Every class shares one shape; only their instance size and image differ.
  return env[CLASS_BINDINGS[containerClass as MiniToolClass]];
}

/**
 * The binding a known class is reached through when this deployment has not configured it (`MINI_TOOL_GL` is optional,
 * so a deployment without the GL image answers its jobs with the binding's name rather than a crash).
 * @param env - The bindings.
 * @param containerClass - The class a job names.
 * @returns The missing binding's name, or null.
 */
function missingBinding(env: JobsEnv, containerClass: string): string | null {
  if (!Object.hasOwn(CLASS_BINDINGS, containerClass)) return null;
  const binding = CLASS_BINDINGS[containerClass as MiniToolClass];
  return env[binding] === undefined ? binding : null;
}

/**
 * `POST /jobs` — start a job, or answer the one already holding its id.
 * @param request - The request.
 * @param env - The bindings.
 * @returns 200 with the job's report; 400 for a body that is not a job or a
 *   class this Worker does not bind; 401 without the secret; 503 naming the
 *   binding when the class's binding is not configured, or when the container
 *   could not start.
 */
export async function submitJob(request: Request, env: JobsEnv): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const version = typeof body === "object" && body !== null && "schemaVersion" in body ? body.schemaVersion : undefined;
  const parsed = version === 2 ? miniToolPlanJobRequestSchema.safeParse(body) : miniToolJobRequestSchema.safeParse(body);
  if (!parsed.success) return new Response("Not a job", { status: 400 });
  const job = parsed.data;
  const missing = missingBinding(env, job.containerClass);
  if (missing !== null) {
    noteFailure("ingest_mini_tool_binding_missing", { jobId: job.jobId, containerClass: job.containerClass, binding: missing });
    return new Response(`The ${missing} binding is not configured`, { status: 503 });
  }
  const namespace = namespaceOf(env, job.containerClass);
  if (namespace === null) return new Response("Unknown container class", { status: 400 });
  try {
    const report = await namespace.get(namespace.idFromName(job.jobId)).submit(job);
    return Response.json(report);
  } catch (err) {
    if (err instanceof JobIdentityConflict || (err instanceof Error && err.name === "JobIdentityConflict")) return new Response("Job identity conflict", { status: 409 });
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
 * @returns 200 with its report; 404 when that class holds no such job; 401 without the secret; 503 naming the binding
 *   when the class's binding is not configured.
 */
export async function readJob(request: Request, env: JobsEnv, containerClass: string, jobId: string): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const missing = missingBinding(env, decodeURIComponent(containerClass));
  if (missing !== null) return new Response(`The ${missing} binding is not configured`, { status: 503 });
  const namespace = namespaceOf(env, decodeURIComponent(containerClass));
  if (namespace === null) return new Response("No such job", { status: 404 });
  const report = await namespace.get(namespace.idFromName(decodeURIComponent(jobId))).report();
  return report === null ? new Response("No such job", { status: 404 }) : Response.json(report);
}
