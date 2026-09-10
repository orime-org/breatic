// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The worker's way into a backend upload (#181 lanes ② and ③, #206 §3.4.1).
 *
 * Both lanes end in the same registration, and registration runs in a library
 * that holds no logger. Three things can fail in it without failing the
 * upload — the reclaim job for an object that lost a dedup race, the node's
 * counts, the project's activity row — so they come back as fields for an
 * application layer to write down. Each is the only account anybody gets of
 * that failure.
 *
 * Every one of the worker's uploads goes through here rather than calling the
 * domain lane itself, so receiving those fields and dropping them is not a
 * thing a handler can do by forgetting.
 */

import { logger } from "@breatic/core";
import {
  backendUploadService,
  type BackendUploadContext,
  type StoredAsset,
} from "@breatic/domain";

/**
 * Write down what registration could not do.
 * @param stored - The registered asset, and whatever failed beside it.
 */
function note(stored: StoredAsset): void {
  if (stored.reclaimQueueFailed === true) {
    logger.error(
      { assetId: stored.assetId, url: stored.fileUrl },
      "ingest_report_reclaim_queue_failed",
    );
  }
  if (stored.countsPublishFailed === true) {
    logger.error(
      { assetId: stored.assetId, url: stored.fileUrl },
      "node_task_counts_publish_failed",
    );
  }
  if (stored.activityAppendFailed === true) {
    logger.error(
      { assetId: stored.assetId, url: stored.fileUrl },
      "activity_record_failed",
    );
  }
}

/**
 * Send bytes this process holds through the ingest Worker (lane ②).
 * @param bytes - What to store.
 * @param ctx - What this upload is and who it belongs to.
 * @returns The registered asset.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {UploadHttpError} When the Worker refused the bytes.
 * @throws {Error} When nothing was registered.
 */
export async function storeBytes(
  bytes: Blob,
  ctx: BackendUploadContext,
): Promise<StoredAsset> {
  const stored = await backendUploadService.uploadBytesToStorage(bytes, ctx);
  note(stored);
  return stored;
}

/**
 * Have the ingest Worker pull a provider's link into R2 (lane ③).
 * @param sourceUrl - The provider's temporary link.
 * @param ctx - What this upload is and who it belongs to.
 * @returns The registered asset.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {UploadHttpError} When the Worker could not store the source.
 * @throws {Error} When nothing was registered.
 */
export async function storeFromUrl(
  sourceUrl: string,
  ctx: BackendUploadContext,
): Promise<StoredAsset> {
  const stored = await backendUploadService.transferUrlToStorage(
    sourceUrl,
    ctx,
  );
  note(stored);
  return stored;
}
