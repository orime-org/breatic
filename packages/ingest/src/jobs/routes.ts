// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The job endpoints (inner#888 §8.1, inner#1711 §3.7). Only our worker calls them: each takes the shared secret. A
 * job lives in the object its class's namespace names after the job id, so submitting the same id again reaches the
 * same object, and reading names the class the job was submitted to.
 *
 * Web-animation execution is optional on a deployment: without the `WEB_ANIMATION` binding or a non-empty
 * `HARNESS_OPENROUTER_API_KEY`, its submit, read and cancel answer 501 `feature_disabled` before the namespace is
 * touched, which the worker reads as a terminal answer, while every other job keeps working.
 */

import { miniToolJobRequestSchema } from "@breatic/shared";
import {
  WEB_ANIMATION_CONTAINER_CLASS,
  webAnimationJobCancelSchema,
  webAnimationJobRequestSchema,
} from "@breatic/shared/space-content";

import { fromOurBackend } from "@ingest/backend-secret.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import {
  CLASS_BINDINGS,
  JobStartFailed,
  type MiniToolClass,
  type MiniToolEnv,
} from "@ingest/jobs/mini-tool-container.js";
import type { WebAnimationEnv } from "@ingest/jobs/web-animation-container.js";

/** What the job endpoints read. */
export type JobsEnv = MiniToolEnv & WebAnimationEnv & { INGEST_SHARED_SECRET: string };

/** `/jobs/<class>/<id>`. */
export const JOB_PATH = /^\/jobs\/([^/]+)\/([^/]+)$/;

/** `/jobs/WebAnimationContainer/<id>/cancel`. */
export const WEB_ANIMATION_CANCEL_PATH = new RegExp(`^/jobs/${WEB_ANIMATION_CONTAINER_CLASS}/([^/]+)/cancel$`);

/**
 * The namespace a mini-tool class is bound under.
 * @param env - The bindings.
 * @param containerClass - The class a job names.
 * @returns The namespace, or null for a class this Worker does not bind.
 */
function namespaceOf(env: JobsEnv, containerClass: string): MiniToolEnv["MINI_TOOL_STD1"] | null {
  if (!Object.hasOwn(CLASS_BINDINGS, containerClass)) return null;
  // Both classes share one shape; only their instance size differs.
  return env[CLASS_BINDINGS[containerClass as MiniToolClass]];
}

/**
 * The web-animation namespace, when the feature is configured.
 * @param env - The bindings.
 * @returns The namespace, or null when the binding or the OpenRouter key is missing.
 */
function webAnimationNamespace(env: JobsEnv): NonNullable<WebAnimationEnv["WEB_ANIMATION"]> | null {
  return env.WEB_ANIMATION !== undefined && env.HARNESS_OPENROUTER_API_KEY ? env.WEB_ANIMATION : null;
}

/**
 * The answer while web-animation execution is not configured.
 * @returns 501 `feature_disabled`.
 */
function featureDisabled(): Response {
  return new Response("feature_disabled", { status: 501 });
}

/**
 * Whether an error is a container that could not start, as it arrives across RPC.
 * @param err - What was thrown.
 * @returns True for {@link JobStartFailed}.
 */
function isStartFailure(err: unknown): boolean {
  return err instanceof JobStartFailed || (err instanceof Error && err.name === "JobStartFailed");
}

/**
 * Start a web-animation job, or answer the one already holding its id.
 * @param body - The parsed request body.
 * @param env - The bindings.
 * @returns 200 with its report; 400 for a body that is not a job; 410 after a cancel that came before any submit;
 *   501 when the feature is off; 503 when the container could not start.
 * @throws {unknown} What the object throws other than a start failure.
 */
async function submitWebAnimationJob(body: unknown, env: JobsEnv): Promise<Response> {
  const namespace = webAnimationNamespace(env);
  if (namespace === null) return featureDisabled();
  const parsed = webAnimationJobRequestSchema.safeParse(body);
  if (!parsed.success) return new Response("Not a job", { status: 400 });
  const job = parsed.data;
  try {
    const answer = await namespace.get(namespace.idFromName(job.jobId)).submit(job);
    if (!("report" in answer)) return new Response("Cancelled before it was submitted", { status: 410 });
    return Response.json(answer.report);
  } catch (err) {
    if (!isStartFailure(err)) throw err;
    noteFailure("ingest_web_animation_start_failed", { jobId: job.jobId }, err);
    return new Response("The container could not start", { status: 503 });
  }
}

/**
 * `POST /jobs` — start a job, or answer the one already holding its id.
 * @param request - The request.
 * @param env - The bindings.
 * @returns 200 with the job's report; 400 for a body that is not a job or a class this Worker does not bind; 401
 *   without the secret; 503 when the container could not start; web-animation answers as above.
 * @throws {unknown} What a job object throws other than a start failure.
 */
export async function submitJob(request: Request, env: JobsEnv): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (typeof body === "object" && body !== null && (body as { containerClass?: unknown }).containerClass === WEB_ANIMATION_CONTAINER_CLASS) {
    return submitWebAnimationJob(body, env);
  }
  const parsed = miniToolJobRequestSchema.safeParse(body);
  if (!parsed.success) return new Response("Not a job", { status: 400 });
  const job = parsed.data;
  const namespace = namespaceOf(env, job.containerClass);
  if (namespace === null) return new Response("Unknown container class", { status: 400 });
  try {
    const report = await namespace.get(namespace.idFromName(job.jobId)).submit(job);
    return Response.json(report);
  } catch (err) {
    if (!isStartFailure(err)) throw err;
    noteFailure("ingest_mini_tool_start_failed", { jobId: job.jobId, containerClass: job.containerClass }, err);
    return new Response("The container could not start", { status: 503 });
  }
}

/**
 * `GET /jobs/<class>/<id>` — how a job is doing.
 * @param request - The request.
 * @param env - The bindings.
 * @param containerClass - The class it was submitted to.
 * @param jobId - Its id.
 * @returns 200 with its report; 404 when that class holds no such job; 401 without the secret; 501 for a
 *   web-animation job while the feature is off.
 */
export async function readJob(request: Request, env: JobsEnv, containerClass: string, jobId: string): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const className = decodeURIComponent(containerClass);
  if (className === WEB_ANIMATION_CONTAINER_CLASS) {
    const namespace = webAnimationNamespace(env);
    if (namespace === null) return featureDisabled();
    const report = await namespace.get(namespace.idFromName(decodeURIComponent(jobId))).report();
    return report === null ? new Response("No such job", { status: 404 }) : Response.json(report);
  }
  const namespace = namespaceOf(env, className);
  if (namespace === null) return new Response("No such job", { status: 404 });
  const report = await namespace.get(namespace.idFromName(decodeURIComponent(jobId))).report();
  return report === null ? new Response("No such job", { status: 404 }) : Response.json(report);
}

/**
 * `POST /jobs/WebAnimationContainer/<id>/cancel` — stop a job; with none yet, refuse its submit until the body's
 * deadline.
 * @param request - The request, carrying `{deadlineAt}`.
 * @param env - The bindings.
 * @param jobId - The URL-encoded job id.
 * @returns 200 with the report after the cancel; 400 for a body that is not a cancel; 401 without the secret; 501
 *   while the feature is off.
 */
export async function cancelWebAnimationJob(request: Request, env: JobsEnv, jobId: string): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  const namespace = webAnimationNamespace(env);
  if (namespace === null) return featureDisabled();
  const parsed = webAnimationJobCancelSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return new Response("Not a cancel", { status: 400 });
  const report = await namespace.get(namespace.idFromName(decodeURIComponent(jobId))).cancel(parsed.data.deadlineAt);
  return Response.json(report);
}
