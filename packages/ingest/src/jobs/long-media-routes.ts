// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { verifyLongMediaJobRequest, type LongMediaJobRequest } from "@breatic/shared";
import type { OutboundHandlerContext } from "@cloudflare/containers";

import { fromOurBackend } from "@ingest/backend-secret.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import { buildLongMediaProbeReport } from "@ingest/long-media-probe-report.js";
import { askedKey } from "@ingest/object-url.js";
import { serveOneObject } from "@ingest/media-object-route.js";
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

/** The hostname used only by the Container's report callback. */
export const LONG_MEDIA_REPORT_HOST = "long-media.local";

/** Trusted identity persisted in the Container's outbound callback route. */
export interface LongMediaProbeCallbackContext {
  attemptId: string;
  epoch: number;
  sourceFingerprint: string;
  profileVersion: string;
}

/** One exact R2 object and size the probe attempt may read. */
export interface LongMediaSourceContext {
  key: string;
  sizeBytes: number;
}

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
    try {
      await stub.startProbe();
    } catch (err) {
      noteFailure("ingest_long_media_probe_start_failed", { jobId: job.jobId }, err);
    }
    const snapshot = await stub.report();
    return Response.json(snapshot ?? result.snapshot, { status: result.kind === "replayed" ? 200 : 202 });
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

/**
 * Validate and persist one Container probe callback against its fenced attempt.
 * @param request - The raw ffprobe report from the intercepted Container host.
 * @param env - The Worker's Durable Object namespace.
 * @param context - The trusted callback identity bound when the run started.
 * @returns 200 when accepted or replayed, 409 when the attempt is stale, and 400 for invalid output.
 */
export async function acceptLongMediaProbeReport(
  request: Request,
  env: Pick<LongMediaEnv, "LONG_MEDIA">,
  context: OutboundHandlerContext<LongMediaProbeCallbackContext>,
): Promise<Response> {
  let stdout: string;
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || !("stdout" in body) || typeof body.stdout !== "string") {
      return new Response("Invalid probe report", { status: 400 });
    }
    stdout = body.stdout;
  } catch {
    return new Response("Invalid probe report", { status: 400 });
  }
  let report;
  try {
    report = buildLongMediaProbeReport(stdout, context.params.sourceFingerprint, context.params.profileVersion);
  } catch (err) {
    noteFailure("ingest_long_media_probe_report_invalid", { containerId: context.containerId }, err);
    return new Response("Invalid probe report", { status: 400 });
  }
  try {
    const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromString(context.containerId));
    const result = await stub.applyProbeReport(context.params.attemptId, context.params.epoch, report, Date.now());
    return result.kind === "accepted" || result.kind === "replayed"
      ? new Response(null, { status: 200 })
      : new Response("Stale probe report", { status: 409 });
  } catch (err) {
    noteFailure("ingest_long_media_probe_report_persist_failed", { containerId: context.containerId }, err);
    throw err;
  }
}

/**
 * Serve only the immutable source assigned to a long-media probe attempt.
 * @param request - The Container's range or whole-object request.
 * @param env - The Worker's R2 binding.
 * @param context - The exact key and size authorized for this probe.
 * @returns The source, or a refusal when the key or stored size differs.
 */
export async function serveLongMediaSource(
  request: Request,
  env: Pick<LongMediaEnv, "BUCKET">,
  context: OutboundHandlerContext<LongMediaSourceContext>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not allowed", { status: 405 });
  let key: string;
  try {
    key = askedKey(request);
  } catch {
    return new Response("Invalid source key", { status: 400 });
  }
  if (key !== context.params.key) return new Response("Not this object", { status: 403 });
  const head = await env.BUCKET.head(context.params.key);
  if (head === null) return new Response("No such object", { status: 404 });
  if (head.size !== context.params.sizeBytes) return new Response("Source size changed", { status: 409 });
  return serveOneObject(request, env.BUCKET, context.params.key);
}
