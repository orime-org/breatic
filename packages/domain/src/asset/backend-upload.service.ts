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
  sendBytesToIngest,
  signUploadTicket,
  type IngestOutcome,
  type IngestTarget,
  type StudioAssetEntity,
  type UploadClientConfig,
} from "@breatic/shared";
import { issueUploadGrant } from "@domain/asset/upload-grant.service.js";

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
 * @returns The signed ticket and where to send it.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 */
async function openBackendUpload(
  ctx: BackendUploadContext,
  declaredSize: number,
): Promise<IngestTarget> {
  const { ingest } = getStorageConfig();
  const { key, studioId } = await issueUploadGrant({
    projectId: ctx.projectId,
    actingUserId: ctx.actingUserId,
    declaredSize,
    taskType: ctx.taskType,
    ext: ctx.ext,
    expiresAt: new Date(Date.now() + ingest.ticket_expires_seconds * 1000),
    context: {
      assetSource: ctx.assetSource,
      ...(ctx.generationTaskId !== undefined && {
        generationTaskId: ctx.generationTaskId,
      }),
      derived: true,
    },
  });

  // A single-part upload is exempt from R2's 5 MiB floor, so a small output
  // travels as one part rather than being padded up to the configured size.
  const totalParts = Math.max(
    1,
    Math.ceil(declaredSize / ingest.part_size_bytes),
  );
  return {
    ticket: await signUploadTicket(
      {
        storageKey: key,
        studioId,
        userId: ctx.actingUserId,
        totalParts,
        partSize: ingest.part_size_bytes,
        contentType: ctx.contentType,
        expiresAt: Date.now() + ingest.ticket_expires_seconds * 1000,
        sessionTokenTtlSeconds: ingest.session_token_ttl_seconds,
      },
      env.INGEST_SHARED_SECRET,
    ),
    uploadUrl: env.INGEST_BASE_URL,
    partSize: ingest.part_size_bytes,
    totalParts,
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
 * @param bytes - What to store.
 * @param ctx - What this upload is and who it belongs to.
 * @returns The registered asset, as the report handler filed it.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {UploadHttpError} When the Worker refuses any step.
 * @throws {unknown} The transport's own failure when nothing answered.
 */
export async function uploadBytesToStorage(
  bytes: Buffer,
  ctx: BackendUploadContext,
): Promise<IngestOutcome> {
  const target = await openBackendUpload(ctx, bytes.byteLength);
  return sendBytesToIngest(new Blob([bytes]), target, uploadKnobs());
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
 * @throws {unknown} The transport's own failure when nothing answered.
 */
export async function transferUrlToStorage(
  sourceUrl: string,
  ctx: BackendUploadContext,
): Promise<IngestOutcome> {
  const { upload } = getStorageConfig();
  const target = await openBackendUpload(ctx, upload.max_upload_bytes);
  return fetchUrlToIngest(sourceUrl, target, env.INGEST_SHARED_SECRET);
}
