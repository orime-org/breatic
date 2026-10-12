// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Data access for `ads_conversion_uploads`. */

import { and, eq, inArray } from "drizzle-orm";
import type { AdsConversionJob, AdsConversionName, AdsUploadStatus } from "@core/ads/ads-types.js";
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
 * @returns True when the row was in one of `from` and moved.
 */
export async function moveUpload(
  key: { conversion: AdsConversionName; transactionId: string },
  from: readonly AdsUploadStatus[],
  to: AdsUploadStatus,
): Promise<boolean> {
  const rows = await db
    .update(adsConversionUploads)
    .set({ status: to, updatedAt: new Date() })
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

/**
 * Find the conversion recorded for a credit order.
 * @param paymentId - The order.
 * @returns Its status and job, or null when none was queued.
 */
export async function findUploadByPayment(
  paymentId: string,
): Promise<{ status: AdsUploadStatus; job: AdsConversionJob } | null> {
  const [row] = await db
    .select({ status: adsConversionUploads.status, job: adsConversionUploads.job })
    .from(adsConversionUploads)
    .where(eq(adsConversionUploads.paymentId, paymentId))
    .limit(1);
  return row ? { status: row.status as AdsUploadStatus, job: row.job } : null;
}
