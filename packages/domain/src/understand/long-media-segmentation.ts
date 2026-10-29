// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { env, getStorageAdapter, getUnderstandConfig, storageKey } from "@breatic/core";
import {
  computeLongMediaInputsDigest,
  computeLongMediaJobRequestDigest,
  httpRequest,
  planLongMediaSegments,
  type LongMediaJobPayload,
  type LongMediaPlanRequest,
  type LongMediaProbeReport,
  type LongMediaSourceReference,
} from "@breatic/shared";
import { applyIngestReport } from "@domain/asset/ingest-report.service.js";
import { issueGrant, voidGrant } from "@domain/asset/upload-grant.repo.js";
import { resolveOwnerStudioId } from "@domain/asset/asset.service.js";

/** A measured and registered output segment in source-time order. */
export interface RegisteredLongMediaSegment {
  url: string;
  ledgerType: string;
  sizeBytes: number;
  startUs: string;
  endUs: string;
}

/** One step of the durable long-media Container protocol. */
export type LongMediaSegmentationProgress =
  | { kind: "pending" }
  | { kind: "ready"; segments: RegisteredLongMediaSegment[] };

/** Cancellation began but cleanup of a locally issued upload grant failed. */
export class LongMediaCancellationError extends Error {
  /**
   * Build an error that keeps failed cancellation cleanup visible to the caller.
   * @param cause - The failed grant cleanup operation.
   */
  constructor(cause: unknown) {
    super("Long-media cancellation cleanup could not be confirmed.", { cause });
    this.name = "LongMediaCancellationError";
  }
}

/** The identity and ownership required to advance one long-media job. */
export interface AdvanceLongMediaSegmentationInput {
  source: LongMediaSourceReference;
  sourceUrl: string;
  actorUserId: string;
  projectId: string;
  operationId: string;
  deadlineAt: number;
  maxSourceBytes: number;
  signal?: AbortSignal;
}

interface LongMediaJobSnapshot {
  jobId: string;
  operationId: string;
  sourceIndex: number;
  phase: "accepted" | "probing" | "planning" | "running" | "stopping" | "done" | "failed" | "cancelled" | "expired";
  version: number;
  deadlineAt: number;
  terminalIntent: "failed" | "cancelled" | "expired" | null;
}

interface LongMediaSegmentSnapshot {
  id: string;
  mediaInputId: string;
  descriptor: LongMediaPlanRequest["intervals"][number]["descriptor"];
  core: { startUs: string; endUs: string };
  decode: { startUs: string; endUs: string };
  grantId: string | null;
  storageKey: string | null;
  measured: { sha256: string; sizeBytes: number; contentType: string } | null;
  status: "planned" | "encoding" | "oversize" | "stored" | "ready" | "superseded" | "paused" | "failed";
  version: number;
}

/**
 * Advance the durable Container job without holding a worker slot while it runs.
 * @param input - The registered source and the caller's operation ownership.
 * @returns Pending until every canonical segment is registered, then the ordered assets.
 * @throws {Error} When the job, source, plan, Container output, or registration fails.
 */
export async function advanceLongMediaSegmentation(
  input: AdvanceLongMediaSegmentationInput,
): Promise<LongMediaSegmentationProgress> {
  input.signal?.throwIfAborted();
  const config = getUnderstandConfig().long_media;
  const segmentLimit = Math.min(config.max_segment_bytes, input.maxSourceBytes);
  if (input.source.sizeBytes > config.max_source_bytes) {
    throw new RangeError("The source exceeds the configured long-media byte limit.");
  }
  if (!Number.isSafeInteger(segmentLimit) || segmentLimit < 1 || !Number.isSafeInteger(input.deadlineAt) ||
    input.deadlineAt <= Date.now()) {
    throw new RangeError("The long-media source limit or deadline is invalid.");
  }

  const adapter = await getStorageAdapter();
  input.signal?.throwIfAborted();
  const sourceKey = adapter.keyFromUrl(input.sourceUrl);
  if (sourceKey === null || sourceKey !== input.source.key) {
    throw new Error("Long-media processing requires the source's canonical stored URL.");
  }
  const jobId = `understand_${input.operationId}_0`;
  const payload: LongMediaJobPayload = {
    protocolVersion: 1,
    jobId,
    operationId: input.operationId,
    sourceIndex: 0,
    source: { key: input.source.key, sha256: input.source.sha256, sizeBytes: input.source.sizeBytes },
    profileId: config.profile_version,
    profileVersion: config.profile_version,
    encodingProfile: {
      audioCodec: config.audio_codec,
      audioBitrate: config.audio_bitrate,
      videoCodec: config.video_codec,
      videoCrf: config.video_crf,
      videoAudioCodec: config.video_audio_codec,
      videoAudioBitrate: config.video_audio_bitrate,
    },
    limitsSnapshot: {
      maxSourceBytes: config.max_source_bytes,
      maxSources: config.max_sources,
      maxSegmentBytes: segmentLimit,
      audioCoreSeconds: config.audio_core_seconds,
      videoCoreSeconds: config.video_core_seconds,
      maxActiveLeaves: config.max_active_leaves,
      maxConcurrentSegments: config.max_concurrent_encoders,
    },
    deadlineAt: input.deadlineAt,
  };
  const requestDigest = await computeLongMediaJobRequestDigest(payload);
  const baseUrl = `${env.INGEST_BASE_URL}/long-media/jobs`;
  const headers = { "content-type": "application/json", "x-ingest-secret": env.INGEST_SHARED_SECRET };
  const jobResponse = await httpRequest(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, requestDigest }),
  }, { replaySafe: true, timeoutMs: 10_000 });
  const job = await jsonResponse<LongMediaJobSnapshot>(jobResponse, "submit long-media job");
  input.signal?.throwIfAborted();
  if (["failed", "cancelled", "expired"].includes(job.phase)) {
    throw new Error(`The long-media Container job ended as ${job.phase}.`);
  }

  const probeResponse = await requestAt(`${baseUrl}/${encodeURIComponent(jobId)}/probe`, "GET", headers, undefined, input.signal);
  if (probeResponse.status === 404) return { kind: "pending" };
  const probe = await jsonResponse<LongMediaProbeReport>(probeResponse, "read long-media probe");
  const mediaInput = probe.mediaInputs[0];
  if (mediaInput === undefined) throw new Error("The long-media probe returned no source file.");
  const planned = planLongMediaSegments([{
    mediaInputId: mediaInput.mediaInputId,
    descriptor: mediaInput.descriptor,
    sourceRange: mediaInput.sourceRange,
  }], {
    audioCoreSeconds: config.audio_core_seconds,
    videoCoreSeconds: config.video_core_seconds,
    maxActiveLeaves: config.max_active_leaves,
  });
  const inputsDigest = await computeLongMediaInputsDigest(input.source.sha256, config.profile_version, probe.mediaInputs);
  let segments = await readSegments(baseUrl, jobId, headers, input.signal);
  if (segments.length === 0) {
    const grants = await createSegmentGrants(input, planned, segmentLimit, input.signal);
    const rootPlan: LongMediaPlanRequest = {
      expectedVersion: 0,
      mutationId: `${jobId}:root`,
      requiredMediaInputs: probe.mediaInputs,
      requiredMediaInputsDigest: inputsDigest,
      mediaInputId: mediaInput.mediaInputId,
      parentId: null,
      intervals: planned.map((segment) => ({ ...segment, mode: "prepare" })),
      grants: grants.map(({ segmentId, candidateId, grantId, storageKey: key }) => ({ segmentId, candidateId, grantId, storageKey: key })),
    };
    const planResponse = await requestAt(
      `${baseUrl}/${encodeURIComponent(jobId)}/plan`, "PUT", headers, rootPlan, input.signal,
    ).catch(async (err: unknown) => {
      if (input.signal?.aborted) await voidSegmentGrants(grants);
      throw err;
    });
    if (planResponse.status !== 409) await jsonResponse<unknown>(planResponse, "write long-media root plan");
    segments = await readSegments(baseUrl, jobId, headers, input.signal);
    if (segments.length === 0) throw new Error("The long-media root plan was not persisted.");
  }

  if (segments.some((segment) => segment.status === "failed")) {
    throw new Error("A required long-media segment failed.");
  }
  const oversize = segments.filter((segment) => segment.status === "oversize");
  let manifestRevision = 1 + (segments.length - planned.length) / 2;
  for (const parent of oversize) {
    input.signal?.throwIfAborted();
    const children = bisectSegment(parent);
    const grants = await createSegmentGrants(input, children, segmentLimit, input.signal);
    const replacement: LongMediaPlanRequest = {
      expectedVersion: manifestRevision,
      mutationId: `${jobId}:split:${parent.id}`,
      requiredMediaInputs: probe.mediaInputs,
      requiredMediaInputsDigest: inputsDigest,
      mediaInputId: parent.mediaInputId,
      parentId: parent.id,
      intervals: children.map((segment) => ({ ...segment, mode: "prepare" })),
      grants: grants.map(({ segmentId, candidateId, grantId, storageKey: key }) => ({ segmentId, candidateId, grantId, storageKey: key })),
    };
    const planResponse = await requestAt(
      `${baseUrl}/${encodeURIComponent(jobId)}/plan`, "PUT", headers, replacement, input.signal,
    ).catch(async (err: unknown) => {
      if (input.signal?.aborted) await voidSegmentGrants(grants);
      throw err;
    });
    if (planResponse.status !== 409) {
      await jsonResponse<unknown>(planResponse, "write long-media split plan");
    } else {
      const latest = await readSegments(baseUrl, jobId, headers, input.signal);
      if (!latest.some((segment) => segment.id === parent.id && segment.status === "superseded")) {
        throw new Error("The long-media split plan conflicted before its parent was replaced.");
      }
    }
    manifestRevision += 1;
  }

  const active = segments.filter((segment) => segment.status !== "superseded");
  if (active.some((segment) => segment.status === "planned" || segment.status === "paused" || segment.status === "oversize")) {
    const runResponse = await requestAt(`${baseUrl}/${encodeURIComponent(jobId)}/run`, "POST", headers, {}, input.signal);
    await jsonResponse<unknown>(runResponse, "start long-media segments");
    return { kind: "pending" };
  }

  const references: RegisteredLongMediaSegment[] = [];
  for (const segment of active.sort((a, b) => BigInt(a.core.startUs) < BigInt(b.core.startUs) ? -1 : 1)) {
    if (segment.status === "ready") {
      const registered = await findRegisteredSegment(input, segment);
      references.push(registered);
      continue;
    }
    if (segment.status !== "stored" || segment.storageKey === null || segment.measured === null) {
      return { kind: "pending" };
    }
    const outcome = await applyIngestReport({ storageKey: segment.storageKey, outcome: "completed", ...segment.measured });
    if (outcome.status !== "registered" && outcome.status !== "already_registered") {
      throw new Error("A long-media segment could not be registered as a canonical asset.");
    }
    const ack = await requestAt(
      `${baseUrl}/${encodeURIComponent(jobId)}/segments/${encodeURIComponent(segment.id)}/registered`,
      "POST",
      headers,
      { expectedVersion: segment.version },
      input.signal,
    );
    await jsonResponse<unknown>(ack, "acknowledge long-media registration");
      references.push({
        url: outcome.fileUrl,
        ledgerType: outcome.mimeType ?? segment.measured.contentType,
        sizeBytes: outcome.sizeBytes ?? segment.measured.sizeBytes,
        startUs: segment.core.startUs,
        endUs: segment.core.endUs,
      });
  }
  if (references.length !== active.length) return { kind: "pending" };
  return { kind: "ready", segments: references };
}

/**
 * Cancel one durable long-media job and void any segment grants it did not consume.
 * @param operationId - The operation identity used to derive its job id.
 * @param deadlineAt - The operation's absolute deadline for expiring a pre-submit cancellation marker.
 * @returns Nothing after Ingest has stopped the job and grants are reconciled.
 * @throws {Error} When Ingest cannot confirm cancellation or a grant cannot be voided.
 */
export async function cancelLongMediaSegmentation(operationId: string, deadlineAt: number): Promise<void> {
  const jobId = `understand_${operationId}_0`;
  const baseUrl = `${env.INGEST_BASE_URL}/long-media/jobs/${encodeURIComponent(jobId)}`;
  const headers = { "content-type": "application/json", "x-ingest-secret": env.INGEST_SHARED_SECRET };
  const response = await httpRequest(`${baseUrl}/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ deadlineAt }),
  }, { replaySafe: true, timeoutMs: 10_000 });
  const cancelled = await jsonResponse<LongMediaJobSnapshot | {
    jobId: string;
    phase: "cancelled";
    beforeSubmit: true;
  }>(response, "cancel long-media job");
  if ("beforeSubmit" in cancelled && cancelled.beforeSubmit) return;
  const segments = await readSegments(`${env.INGEST_BASE_URL}/long-media/jobs`, jobId, headers);
  await Promise.all(segments.flatMap((segment) =>
    segment.storageKey === null ? [] : [voidGrant(segment.storageKey, "cancelled")],
  ));
}

/**
 * Create upload-ledger grants for output segments before the Container receives write authority.
 * @param input - The owning user and project.
 * @param segments - The planned source-time intervals.
 * @param maxBytes - The maximum measured size the Container may write.
 * @param signal - The turn cancellation signal, when present.
 * @returns Exact durable output grants keyed by segment identity.
 * @throws {Error} When a segment grant cannot be recorded.
 */
export async function createSegmentGrants(
  input: AdvanceLongMediaSegmentationInput,
  segments: readonly Pick<LongMediaPlanRequest["intervals"][number], "id" | "descriptor">[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Array<{ segmentId: string; candidateId: string; grantId: string; storageKey: string }>> {
  const ownerStudioId = await resolveOwnerStudioId(input.projectId);
  signal?.throwIfAborted();
  const grants: Array<{ segmentId: string; candidateId: string; grantId: string; storageKey: string }> = [];
  try {
    for (const segment of segments) {
      signal?.throwIfAborted();
      const mediaKind = segment.descriptor.mediaKind;
      if (mediaKind !== "audio" && mediaKind !== "video") throw new Error("The segment media kind is invalid.");
      const key = storageKey({ taskType: mediaKind, ext: mediaKind === "audio" ? ".mp3" : ".mp4" });
      const grant = await issueGrant({
        userId: input.actorUserId,
        studioId: ownerStudioId,
        storageKey: key,
        declaredSize: maxBytes,
        expiresAt: new Date(input.deadlineAt),
        context: { projectId: input.projectId, derived: true },
      });
      grants.push({ segmentId: segment.id, candidateId: randomUUID(), grantId: grant.id, storageKey: key });
    }
  } catch (err) {
    if (signal?.aborted) await voidSegmentGrants(grants);
    throw err;
  }
  return grants;
}

/**
 * Split one oversized source-time interval into adjacent non-overlapping children.
 * @param segment - The authoritative oversized interval.
 * @returns The two children covering exactly the parent's interval.
 * @throws {RangeError} When the interval cannot be bisected.
 */
function bisectSegment(segment: LongMediaSegmentSnapshot): Array<Pick<LongMediaPlanRequest["intervals"][number], "id" | "mediaInputId" | "descriptor" | "core" | "decode">> {
  const start = BigInt(segment.core.startUs);
  const end = BigInt(segment.core.endUs);
  if (end - start < 2n) throw new RangeError("An oversized long-media segment cannot be split further.");
  const middle = start + (end - start) / 2n;
  const intervals = [{ startUs: String(start), endUs: String(middle) }, { startUs: String(middle), endUs: String(end) }];
  return intervals.map((core) => ({
    id: `${segment.mediaInputId}:${core.startUs}:${core.endUs}`,
    mediaInputId: segment.mediaInputId,
    descriptor: segment.descriptor,
    core,
    decode: core,
  }));
}

/**
 * Read all measured source-ordered segments from the durable Container job.
 * @param baseUrl - The jobs collection URL.
 * @param jobId - The stable job identity.
 * @param headers - The authenticated backend headers.
 * @param signal - The turn cancellation signal, when present.
 * @returns The current segment snapshots.
 * @throws {Error} When the Worker refuses or returns malformed JSON.
 */
async function readSegments(
  baseUrl: string,
  jobId: string,
  headers: HeadersInit,
  signal?: AbortSignal,
): Promise<LongMediaSegmentSnapshot[]> {
  const response = await requestAt(`${baseUrl}/${encodeURIComponent(jobId)}/segments`, "GET", headers, undefined, signal);
  return jsonResponse<LongMediaSegmentSnapshot[]>(response, "read long-media segments");
}

/**
 * Read a canonical asset URL for a segment the Container has already registered.
 * @param input - The asset owner.
 * @param segment - The ready segment identity.
 * @returns Its canonical asset URL and measured media facts.
 * @throws {Error} When the registered asset is no longer available.
 */
async function findRegisteredSegment(
  input: AdvanceLongMediaSegmentationInput,
  segment: LongMediaSegmentSnapshot,
): Promise<RegisteredLongMediaSegment> {
  if (segment.storageKey === null || segment.measured === null) throw new Error("A ready long-media segment has no measurement.");
  const outcome = await applyIngestReport({ storageKey: segment.storageKey, outcome: "completed", ...segment.measured });
  if (outcome.status !== "registered" && outcome.status !== "already_registered") {
    throw new Error(`A ready long-media segment for project ${input.projectId} has no registered asset.`);
  }
  return {
    url: outcome.fileUrl,
    ledgerType: outcome.mimeType ?? segment.measured.contentType,
    sizeBytes: outcome.sizeBytes ?? segment.measured.sizeBytes,
    startUs: segment.core.startUs,
    endUs: segment.core.endUs,
  };
}

/**
 * Send one authenticated request to the ingest Worker's durable job API.
 * @param url - The endpoint.
 * @param method - The HTTP method.
 * @param headers - The backend authentication headers.
 * @param body - The JSON body, when present.
 * @param signal - The turn cancellation signal, when present.
 * @returns The response.
 * @throws {Error} When the transport has no response.
 */
async function requestAt(
  url: string,
  method: string,
  headers: HeadersInit,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return httpRequest(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { replaySafe: true, timeoutMs: 10_000, ...(signal ? { signal } : {}) });
}

/**
 * Void grants created for a plan mutation that was interrupted before persistence.
 * @param grants - The grants allocated for the interrupted mutation.
 * @returns Nothing after every grant is terminal.
 * @throws {Error} When any upload grant cannot be voided.
 */
async function voidSegmentGrants(
  grants: readonly { storageKey: string }[],
): Promise<void> {
  try {
    await Promise.all(grants.map(({ storageKey: key }) => voidGrant(key, "cancelled")));
  } catch (cause) {
    throw new LongMediaCancellationError(cause);
  }
}

/**
 * Require a successful response and decode its JSON body.
 * @param response - The Worker response.
 * @param action - The operation being performed.
 * @returns The decoded response.
 * @throws {Error} When the Worker refuses or returns invalid JSON.
 */
async function jsonResponse<T>(response: Response, action: string): Promise<T> {
  if (!response.ok) throw new Error(`Could not ${action}: ingest answered ${response.status}.`);
  try {
    return await response.json() as T;
  } catch (cause) {
    throw new Error(`Could not ${action}: ingest returned invalid JSON.`, { cause });
  }
}
