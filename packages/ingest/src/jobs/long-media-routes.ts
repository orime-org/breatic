// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { verifyLongMediaJobRequest, type LongMediaJobRequest } from "@breatic/shared";
import type { OutboundHandlerContext } from "@cloudflare/containers";

import { fromOurBackend } from "@ingest/backend-secret.js";
import { noteFailure } from "@ingest/error-monitoring.js";
import { buildLongMediaProbeReport } from "@ingest/long-media-probe-report.js";
import { askedKey } from "@ingest/object-url.js";
import { serveOneObject } from "@ingest/media-object-route.js";
import { hashStoredObject, sniffStoredObject, writeStreamedObject } from "@ingest/stored-object.js";
import type {
  LongMediaContainer,
  LongMediaEnv,
  LongMediaSegmentWritePermit,
} from "@ingest/jobs/long-media-container.js";

/** The namespace and secret required by long media job routes. */
export interface LongMediaRoutesEnv extends LongMediaEnv {
  INGEST_SHARED_SECRET: string;
  LONG_MEDIA: DurableObjectNamespace<LongMediaContainer>;
}

/** `/long-media/jobs/{id}`. */
export const LONG_MEDIA_JOB_PATH = /^\/long-media\/jobs\/([^/]+)$/;

/** `/long-media/jobs/{id}/probe`. */
export const LONG_MEDIA_PROBE_REPORT_PATH = /^\/long-media\/jobs\/([^/]+)\/probe$/;

/** `/long-media/jobs/{id}/plan`. */
export const LONG_MEDIA_PLAN_PATH = /^\/long-media\/jobs\/([^/]+)\/plan$/;

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

/** Trusted identity for writes from one long-media Container. */
export interface LongMediaSegmentOutputContext {
  jobId: string;
}

/** The R2 multipart size used for one bounded long-media output. */
const LONG_MEDIA_SEGMENT_PART_SIZE = 32 * 1024 * 1024;

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
 * Read the validated source probe facts for the trusted Node planner.
 * @param request - The backend request.
 * @param env - The Worker's Durable Object namespace.
 * @param jobId - The URL-encoded job identity.
 * @returns 200 with the report, 401 without the backend secret, or 404 before probe completion.
 */
export async function readLongMediaProbeReport(
  request: Request,
  env: LongMediaRoutesEnv,
  jobId: string,
): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  let decodedJobId: string;
  try {
    decodedJobId = decodeURIComponent(jobId);
  } catch {
    return new Response("No such job", { status: 404 });
  }
  const report = await env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(decodedJobId)).probeReport();
  return report === null ? new Response("Probe not ready", { status: 404 }) : Response.json(report);
}

/**
 * Accept one authenticated, versioned plan mutation for a durable job.
 * @param request - The backend mutation request.
 * @param env - The Worker's bindings.
 * @param jobId - The URL-encoded job identity.
 * @returns The mutation result or a protocol-level error response.
 */
export async function applyLongMediaPlan(
  request: Request,
  env: LongMediaRoutesEnv,
  jobId: string,
): Promise<Response> {
  if (!fromOurBackend(request, env)) return new Response("Unauthorized", { status: 401 });
  let decodedJobId: string;
  let value: unknown;
  try {
    decodedJobId = decodeURIComponent(jobId);
    value = await request.json();
  } catch {
    return new Response("Invalid long media plan", { status: 400 });
  }
  try {
    const result = await env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(decodedJobId)).applyLongMediaPlan(value);
    if (result.kind === "accepted" || result.kind === "replayed") return Response.json(result);
    if (result.kind === "stale" || result.kind === "conflict") return Response.json(result, { status: 409 });
    return Response.json(result, { status: 400 });
  } catch (err) {
    noteFailure("ingest_long_media_plan_failed", { jobId: decodedJobId }, err);
    throw err;
  }
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
  let stdout: string | null = null;
  let failed = false;
  try {
    const body: unknown = await request.json();
    if (body === null || typeof body !== "object" || Object.keys(body).length !== 1) {
      return new Response("Invalid probe report", { status: 400 });
    }
    if ("stdout" in body && typeof body.stdout === "string") stdout = body.stdout;
    else if ("failure" in body && body.failure === "probe_failed") failed = true;
    else return new Response("Invalid probe report", { status: 400 });
  } catch {
    return new Response("Invalid probe report", { status: 400 });
  }
  const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromString(context.containerId));
  if (failed) {
    noteFailure("ingest_long_media_probe_failed", { containerId: context.containerId });
    try {
      const result = await stub.applyProbeFailure(context.params.attemptId, context.params.epoch, Date.now());
      return result.kind === "accepted"
        ? new Response(null, { status: 200 })
        : new Response("Stale probe failure", { status: 409 });
    } catch (err) {
      noteFailure("ingest_long_media_probe_failure_persist_failed", { containerId: context.containerId }, err);
      throw err;
    }
  }
  if (stdout === null) return new Response("Invalid probe report", { status: 400 });
  let report;
  try {
    report = buildLongMediaProbeReport(stdout, context.params.sourceFingerprint, context.params.profileVersion);
  } catch (err) {
    noteFailure("ingest_long_media_probe_report_invalid", { containerId: context.containerId }, err);
    return new Response("Invalid probe report", { status: 400 });
  }
  try {
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

/**
 * Write and measure one segment only when its exact durable grant is running.
 * @param request - The Container's output PUT request.
 * @param env - The Worker's R2 bucket and Durable Object namespace.
 * @param context - The job identity bound to the outbound Container route.
 * @returns 200 after measurement, 403 for an ungranted key, 409 for stale state,
 *   413 when the encoded bytes exceed the frozen limit, or 415 for wrong media.
 */
export async function writeLongMediaSegment(
  request: Request,
  env: Pick<LongMediaEnv, "BUCKET" | "LONG_MEDIA">,
  context: OutboundHandlerContext<LongMediaSegmentOutputContext>,
): Promise<Response> {
  if (request.method !== "PUT" || request.body === null) return new Response("Not allowed", { status: 405 });
  let storageKey: string;
  try {
    storageKey = askedKey(request);
  } catch {
    return new Response("Invalid output key", { status: 400 });
  }
  const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(context.params.jobId));
  const permit = await stub.segmentWritePermit(storageKey);
  if (permit === null) return new Response("Not this output", { status: 403 });
  return storeAuthorizedLongMediaSegment(request, env.BUCKET, stub, permit, context.params.jobId);
}

/**
 * Accept one Container encoding result against the current segment revision.
 * @param request - The segment result callback.
 * @param env - The job namespace.
 * @param context - The job identity bound to the outbound Container route.
 * @returns 200 when the current segment was updated, 409 for stale state, or
 *   400 for an invalid callback.
 */
export async function acceptLongMediaSegmentReport(
  request: Request,
  env: Pick<LongMediaEnv, "LONG_MEDIA">,
  context: OutboundHandlerContext<LongMediaSegmentOutputContext>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Not allowed", { status: 405 });
  const segmentMatch = /^\/segment-report\/([^/]+)$/u.exec(new URL(request.url).pathname);
  if (segmentMatch === null) return new Response("Invalid segment report path", { status: 400 });
  let segmentId: string;
  let outcome: "oversize" | "failed";
  try {
    segmentId = decodeURIComponent(segmentMatch[1] ?? "");
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) {
      return new Response("Invalid segment report", { status: 400 });
    }
    const received = (value as Record<string, unknown>).outcome;
    if (received !== "oversize" && received !== "failed") return new Response("Invalid segment report", { status: 400 });
    outcome = received;
  } catch {
    return new Response("Invalid segment report", { status: 400 });
  }
  const stub = env.LONG_MEDIA.get(env.LONG_MEDIA.idFromName(context.params.jobId));
  if (outcome === "failed") {
    noteFailure("ingest_long_media_segment_encode_failed", {
      jobId: context.params.jobId,
      segmentId,
    });
  }
  const event = outcome === "oversize" ? { type: "oversize" as const } : { type: "fatal" as const };
  const result = await stub.applyCurrentSegmentEvent(segmentId, event);
  return result.kind === "accepted"
    ? new Response(null, { status: 200 })
    : new Response("Stale segment report", { status: 409 });
}

/**
 * Persist one bounded segment and its measurement under the exact current grant.
 * @param request - The Container's complete output stream.
 * @param bucket - R2 storage.
 * @param stub - The Durable Object holding the segment lifecycle.
 * @param permit - The current exact-key output authority.
 * @param jobId - The durable job identity for failure records.
 * @returns The write outcome acknowledged to the Container.
 */
async function storeAuthorizedLongMediaSegment(
  request: Request,
  bucket: R2Bucket,
  stub: DurableObjectStub<LongMediaContainer>,
  permit: LongMediaSegmentWritePermit,
  jobId: string,
): Promise<Response> {
  const contentType = permit.mediaKind === "audio" ? "audio/mp4" : "video/mp4";
  try {
    const stored = await writeStreamedObject(bucket, permit.storageKey, request.body!, {
      contentType,
      partSize: LONG_MEDIA_SEGMENT_PART_SIZE,
      maxBytes: permit.maxBytes,
    });
    if (stored === "over_cap") {
      const result = await stub.applySegmentEvent(permit.segmentId, permit.expectedVersion, { type: "oversize" });
      return result.kind === "accepted" ? new Response("Too large", { status: 413 }) : new Response("Stale output", { status: 409 });
    }
    const measuredContentType = await sniffStoredObject(bucket, permit.storageKey);
    if (!measuredContentType.startsWith(`${permit.mediaKind}/`)) {
      await stub.applySegmentEvent(permit.segmentId, permit.expectedVersion, { type: "fatal" });
      return new Response("Output media kind mismatch", { status: 415 });
    }
    const measured = {
      sha256: await hashStoredObject(bucket, permit.storageKey),
      sizeBytes: stored.sizeBytes,
      contentType: measuredContentType,
    };
    const result = await stub.applySegmentEvent(permit.segmentId, permit.expectedVersion, { type: "measured", measured });
    return result.kind === "accepted" ? new Response(null, { status: 200 }) : new Response("Stale output", { status: 409 });
  } catch (err) {
    noteFailure("ingest_long_media_segment_write_failed", { jobId, segmentId: permit.segmentId }, err);
    await stub.applySegmentEvent(permit.segmentId, permit.expectedVersion, { type: "fatal" }).catch((recordError: unknown) => {
      noteFailure("ingest_long_media_segment_failure_record_failed", { jobId, segmentId: permit.segmentId }, recordError);
    });
    return new Response("Segment write failed", { status: 500 });
  }
}
