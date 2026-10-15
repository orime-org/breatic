// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Data access for `ads_conversion_uploads`. */

import { and, eq, inArray, lt } from "drizzle-orm";
import type { AdsConversionJob, AdsConversionName, AdsFailureReason, AdsUploadStatus } from "@core/ads/ads-types.js";
import { db } from "@core/db/client.js";
import { adsConversionUploads } from "@core/db/schema.js";

/**
 * Record a conversion as queued, once.
 * @param job - The upload.
 * @param paymentId - The credit order it is for, if any.
 * @returns True when this call created the row; false when the conversion was already recorded.
 */
export async function claimUpload(job: AdsConversionJob, paymentId: string | null): Promise<boolean> {
  const rows = await db
    .insert(adsConversionUploads)
    .values({ conversion: job.conversion, transactionId: job.transactionId, paymentId, status: "queued", job })
    .onConflictDoNothing()
    .returning({ status: adsConversionUploads.status });
  return rows.length > 0;
}

/**
 * Move an upload from one of the given states to another.
 * @param key - Which upload.
 * @param key.conversion - Its conversion.
 * @param key.transactionId - Its transaction id.
 * @param from - The states the move is allowed from.
 * @param to - The new state.
 * @param extra - Recorded with the move.
 * @param extra.requestId - The platform's id for an accepted upload.
 * @param extra.failureReason - Why the upload stopped short of the platform.
 * @returns True when the row was in one of `from` and moved.
 */
export async function moveUpload(
  key: { conversion: AdsConversionName; transactionId: string },
  from: readonly AdsUploadStatus[],
  to: AdsUploadStatus,
  extra: { requestId?: string; failureReason?: AdsFailureReason } = {},
): Promise<boolean> {
  const { requestId, failureReason } = extra;
  const rows = await db
    .update(adsConversionUploads)
    .set({ status: to, updatedAt: new Date(), ...(requestId ? { requestId } : {}), ...(failureReason ? { failureReason } : {}) })
    .where(
      and(
        eq(adsConversionUploads.conversion, key.conversion),
        eq(adsConversionUploads.transactionId, key.transactionId),
        inArray(adsConversionUploads.status, [...from]),
      ),
    )
    .returning({ status: adsConversionUploads.status });
  return rows.length > 0;
}

/**
 * Read an upload's state.
 * @param key - Which upload.
 * @param key.conversion - Its conversion.
 * @param key.transactionId - Its transaction id.
 * @returns Its status, or null when it was never queued.
 */
export async function getUploadStatus(key: {
  conversion: AdsConversionName;
  transactionId: string;
}): Promise<AdsUploadStatus | null> {
  const [row] = await db
    .select({ status: adsConversionUploads.status })
    .from(adsConversionUploads)
    .where(
      and(
        eq(adsConversionUploads.conversion, key.conversion),
        eq(adsConversionUploads.transactionId, key.transactionId),
      ),
    )
    .limit(1);
  return (row?.status as AdsUploadStatus | undefined) ?? null;
}

/** An upload row as the queueing code reads it. */
export interface UploadRow {
  readonly status: AdsUploadStatus;
  readonly job: AdsConversionJob;
  readonly requestId: string | null;
}

const uploadColumns = {
  status: adsConversionUploads.status,
  job: adsConversionUploads.job,
  requestId: adsConversionUploads.requestId,
};

/**
 * Uploads still waiting in one of the given states since before a time.
 * @param statuses - The waiting states.
 * @param before - Rows last moved before this time.
 * @returns The rows.
 */
export async function findStaleUploads(statuses: readonly AdsUploadStatus[], before: Date): Promise<UploadRow[]> {
  const rows = await db
    .select(uploadColumns)
    .from(adsConversionUploads)
    .where(and(inArray(adsConversionUploads.status, [...statuses]), lt(adsConversionUploads.updatedAt, before)));
  return rows.map((row) => ({ ...row, status: row.status as AdsUploadStatus }));
}
