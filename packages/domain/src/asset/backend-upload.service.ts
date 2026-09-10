// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending what the backend produced to R2 (#181, lanes ② and ③).
 *
 * A generation leaves its output in one of two places: in our own process, as
 * a buffer a synchronous transport answered with or ffmpeg wrote, or behind a
 * temporary link the provider handed back. Both end up in R2 the same way the
 * browser's files do — through the ingest Worker, which hashes what actually
 * landed — because the hash is what the ledger keys on and a second way of
 * computing it is a second answer to the same question.
 *
 * Neither lane pre-checks for a duplicate. The browser computes a hash before
 * it uploads because doing so can save the upload entirely; here the bytes are
 * already at hand or already remote, so a local hash would buy nothing and
 * dedup happens where it always does — when the asset is registered, with the
 * loser's key queued for offline reclaim.
 *
 * The grant is what carries everything the report handler will need. Neither
 * lane names a node: the worker settles its own task row and writes its own
 * history, and a grant naming a node would have the report handler do both a
 * second time.
 */

import { env, getStorageConfig } from "@breatic/core";
import {
  fetchUrlToIngest,
  finishUploadAtIngest,
  sendBytesToIngest,
  type IngestOutcome,
  type IngestTarget,
  type StudioAssetEntity,
  type UploadClientConfig,
} from "@breatic/shared";
import { issueUploadGrant } from "@domain/asset/upload-grant.service.js";
import { signTicketFor } from "@domain/asset/upload-ticket.service.js";
import {
  applyIngestReport,
  type IngestReportOutcome,
  type IngestSideEffects,
} from "@domain/asset/ingest-report.service.js";

/**
 * A backend upload that reached the ledger.
 *
 * `IngestOutcome` leaves `fileUrl` optional because the browser reads its own
 * result through a different channel and can be told there is none. A backend
 * lane has no such channel: whatever it stored is what a node will point at,
 * so an answer without a url is the upload having failed.
 */
export type StoredAsset = IngestOutcome & {
  fileUrl: string;
} & IngestSideEffects;

/**
 * Read a registration as a stored asset, or fail the upload.
 *
 * Only the two outcomes that name a row can be one. Everything else — a
 * refusal, a void, a report that lost its race — leaves a backend lane with
 * nothing to put on a node, which is the upload having failed.
 * @param outcome - What registering these bytes decided.
 * @param what - Names the upload in the error.
 * @returns The stored row, and whatever the caller has to write down.
 * @throws {Error} When nothing was registered.
 */
function landed(outcome: IngestReportOutcome, what: string): StoredAsset {
  if (
    outcome.status !== "registered" &&
    outcome.status !== "already_registered"
  ) {
    throw new Error(`${what} came back with no url`);
  }
  return {
    assetId: outcome.assetId,
    fileUrl: outcome.fileUrl,
    kind: outcome.kind,
    ...(outcome.countsPublishFailed === true && { countsPublishFailed: true }),
    ...(outcome.reclaimQueueFailed === true && { reclaimQueueFailed: true }),
    ...(outcome.activityAppendFailed === true && {
      activityAppendFailed: true,
    }),
  };
}

/** What every backend upload has to say about itself. */
export interface BackendUploadContext {
  /** Project the output belongs to; it decides the owner studio. */
  projectId: string;
  /** Who this is attributed to. */
  actingUserId: string;
  /** What the resulting asset is: a generation's output, or a video's cover. */
  assetSource: Exclude<StudioAssetEntity["source"], "upload">;
  /** The generation that produced these bytes, when one did. */
  generationTaskId?: string;
  /** The key's task segment, which also decides its extension. */
  taskType: string;
  /** The dotted extension the object is stored under. */
  ext: string;
  /** What the object is served as. */
  contentType: string;
}

/**
 * Open an upload for something the backend produced, and hand back what the
 * ingest Worker needs to accept it.
 *
 * `derived` is set on the grant so the report handler writes no activity row:
 * the worker announces the generation itself, and a second row would report
 * one act twice.
 * @param ctx - What this upload is and who it belongs to.
 * @param declaredSize - The byte size, when it is known; the ceiling on the
 *   number of parts otherwise.
 * @returns The key this upload writes to, the signed ticket, and where to send
 *   it.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 */
async function openBackendUpload(
  ctx: BackendUploadContext,
  declaredSize: number,
): Promise<{ storageKey: string; target: IngestTarget }> {
  const { ingest } = getStorageConfig();
  const expiresAt = Date.now() + ingest.ticket_expires_seconds * 1000;
  const { key, studioId } = await issueUploadGrant({
    projectId: ctx.projectId,
    actingUserId: ctx.actingUserId,
    declaredSize,
    taskType: ctx.taskType,
    ext: ctx.ext,
    expiresAt: new Date(expiresAt),
    context: {
      assetSource: ctx.assetSource,
      ...(ctx.generationTaskId !== undefined && {
        generationTaskId: ctx.generationTaskId,
      }),
      derived: true,
    },
  });

  return {
    storageKey: key,
    target: await signTicketFor({
      storageKey: key,
      studioId,
      userId: ctx.actingUserId,
      declaredSize,
      contentType: ctx.contentType,
      expiresAt,
    }),
  };
}

/**
 * The deadlines a backend upload's parts are given.
 *
 * The same knobs the browser is served, read from the same config, because
 * they answer the same question: how long one part may stall before the
 * delivery is given up on.
 * @returns The knobs.
 */
function uploadKnobs(): UploadClientConfig {
  const { upload } = getStorageConfig();
  return {
    maxUploadBytes: upload.max_upload_bytes,
    clientMaxAttempts: upload.client_max_attempts,
    clientRetryBaseDelayMs: upload.client_retry_base_delay_ms,
    clientRequestTimeoutMs: upload.client_request_timeout_ms,
    clientPutMinBytesPerSec: upload.client_put_min_bytes_per_sec,
  };
}

/**
 * Send bytes we are holding to R2 through the ingest Worker (lane ②).
 *
 * A `Blob` rather than a buffer, so a caller whose bytes are on disk can hand
 * over a file-backed one and have each part read as it is sent; callers already
 * holding the bytes wrap them at their own call site, where that copy was
 * going to happen anyway.
 * @param bytes - What to store.
 * @param ctx - What this upload is and who it belongs to.
 * @returns The registered asset, as the report handler filed it.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {UploadHttpError} When the Worker refuses any step.
 * @throws {Error} When the report filed nothing.
 * @throws {unknown} The transport's own failure when nothing answered.
 */
export async function uploadBytesToStorage(
  bytes: Blob,
  ctx: BackendUploadContext,
): Promise<StoredAsset> {
  const opened = await openBackendUpload(ctx, bytes.size);
  const held = await sendBytesToIngest(bytes, opened.target, uploadKnobs());
  const measured = await finishUploadAtIngest(
    opened.target.uploadUrl,
    held,
    env.INGEST_SHARED_SECRET,
  );
  return landed(
    await applyIngestReport({
      storageKey: opened.storageKey,
      outcome: "completed",
      ...measured,
    }),
    `the upload for project ${ctx.projectId}`,
  );
}

/**
 * Have the Worker pull a provider's URL into R2 (lane ③).
 *
 * The bytes never reach this process. What is declared as the size is the cap
 * an upload is allowed to reach, since a link says nothing about its length,
 * and it becomes the part ceiling the Worker holds the transfer to.
 * @param sourceUrl - The provider's temporary link.
 * @param ctx - What this upload is and who it belongs to.
 * @returns The registered asset, as the report handler filed it.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {UploadHttpError} When the Worker could not store the source.
 * @throws {Error} When the report filed nothing.
 * @throws {unknown} The transport's own failure when nothing answered.
 */
export async function transferUrlToStorage(
  sourceUrl: string,
  ctx: BackendUploadContext,
): Promise<StoredAsset> {
  const { upload } = getStorageConfig();
  const opened = await openBackendUpload(ctx, upload.max_upload_bytes);
  const measured = await fetchUrlToIngest(
    sourceUrl,
    opened.target,
    env.INGEST_SHARED_SECRET,
  );
  return landed(
    await applyIngestReport({
      storageKey: opened.storageKey,
      outcome: "completed",
      ...measured,
    }),
    `the transfer of ${sourceUrl}`,
  );
}
