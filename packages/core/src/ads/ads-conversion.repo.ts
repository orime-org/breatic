// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Data access for `ads_conversion_uploads`. */

import { and, eq, lt } from "drizzle-orm";
import type { AdsConversionJob, AdsConversionName, AdsFailureReason, AdsUploadStatus } from "@core/ads/ads-types.js";
import { db } from "@core/db/client.js";
import { adsConversionUploads } from "@core/db/schema.js";

/**
 * Record a conversion as queued, once.
 * @param job - The upload.
 * @returns True when this call created the row; false when the conversion was already recorded.
 */
export async function claimUpload(job: AdsConversionJob): Promise<boolean> {
  const rows = await db
    .insert(adsConversionUploads)
    .values({ conversion: job.conversion, transactionId: job.transactionId, status: "queued", job })
    .onConflictDoNothing()
    .returning({ status: adsConversionUploads.status });
  return rows.length > 0;
}

/**
 * Record how a queued upload ended; an upload already settled stays as it is.
 * @param key - Which upload.
 * @param key.conversion - Its conversion.
 * @param key.transactionId - Its transaction id.
 * @param to - How it ended.
 * @param extra - Recorded with the outcome.
 * @param extra.requestId - The platform's id for an accepted upload.
 * @param extra.failureReason - Why the upload stopped short of the platform.
 */
export async function settleQueuedUpload(
  key: { conversion: AdsConversionName; transactionId: string },
  to: Exclude<AdsUploadStatus, "queued">,
  extra: { requestId?: string; failureReason?: AdsFailureReason } = {},
): Promise<void> {
  const { requestId, failureReason } = extra;
  await db
    .update(adsConversionUploads)
    .set({ status: to, updatedAt: new Date(), ...(requestId ? { requestId } : {}), ...(failureReason ? { failureReason } : {}) })
    .where(
      and(
        eq(adsConversionUploads.conversion, key.conversion),
        eq(adsConversionUploads.transactionId, key.transactionId),
        eq(adsConversionUploads.status, "queued"),
      ),
    );
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

/**
 * The jobs of uploads still queued since before a time.
 * @param before - Rows last moved before this time.
 * @returns Their jobs.
 */
export async function findStaleUploads(before: Date): Promise<AdsConversionJob[]> {
  const rows = await db
    .select({ job: adsConversionUploads.job })
    .from(adsConversionUploads)
    .where(and(eq(adsConversionUploads.status, "queued"), lt(adsConversionUploads.updatedAt, before)));
  return rows.map((row) => row.job);
}
