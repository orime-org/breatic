// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload a queued ad conversion (inner#1442 design §4.9). The platform sits
 * behind `AdsConversionSink`; Google's Data Manager API is the one sink today.
 */

import { UnrecoverableError, type Job } from "bullmq";
import { IngestionServiceClient } from "@google-ads/datamanager";
import { adsConversionConfig, settleAdsUpload, type AdsConversionConfig, type AdsConversionJob } from "@breatic/core";

/** Where conversions are reported. */
export interface AdsConversionSink {
  /**
   * Send one conversion or restatement.
   * @param job - The upload.
   * @param conversionActionId - The platform's id for the conversion action.
   */
  upload(job: AdsConversionJob, conversionActionId: string): Promise<void>;
}

// gRPC status codes a retry cannot change: INVALID_ARGUMENT, NOT_FOUND,
// PERMISSION_DENIED, FAILED_PRECONDITION, UNAUTHENTICATED.
const PERMANENT_CODES: ReadonlySet<number> = new Set([3, 5, 7, 9, 16]);

/**
 * The Data Manager sink.
 * @param config - The deployment's Google Ads configuration.
 * @returns A sink that calls `events:ingest`.
 */
export function googleDataManagerSink(config: AdsConversionConfig): AdsConversionSink {
  const client = new IngestionServiceClient({ credentials: config.credentials });
  const account = { accountType: "GOOGLE_ADS" as const, accountId: config.customerId };
  return {
    async upload(job, conversionActionId) {
      const { gclid, gbraid, wbraid } = job.click;
      await client.ingestEvents({
        destinations: [{ operatingAccount: account, loginAccount: account, productDestinationId: conversionActionId }],
        // Only browsers that accepted ads are queued (design §4.4.5).
        consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" },
        events: [
          {
            transactionId: job.transactionId,
            eventTimestamp: { seconds: Math.floor(Date.parse(job.occurredAt) / 1000) },
            eventSource: "WEB",
            adIdentifiers: { gclid, gbraid, wbraid },
            ...(job.value
              ? { conversionValue: job.value.amountCents / 100, currency: job.value.currency.toUpperCase() }
              : {}),
          },
        ],
      });
    },
  };
}

/**
 * Whether the platform refused the request for good.
 * @param err - What the upload threw.
 * @returns True for a gRPC status a retry cannot change.
 */
function isPermanent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && PERMANENT_CODES.has(code);
}

/**
 * Upload one queued conversion and record how it ended.
 * @param job - The queued upload.
 * @param sink - Where it goes.
 * @throws {UnrecoverableError} When ad conversions are no longer configured or
 *   the platform refused it for good.
 * @throws {unknown} When the upload failed otherwise, so the queue retries.
 */
export async function runAdsConversion(job: Job<AdsConversionJob>, sink: AdsConversionSink): Promise<void> {
  const actionId = adsConversionConfig()?.actions[job.data.conversion];
  if (actionId === undefined) {
    await settleAdsUpload(job.data, false);
    throw new UnrecoverableError(`no conversion action for ${job.data.conversion}`);
  }
  try {
    await sink.upload(job.data, actionId);
  } catch (err) {
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (isPermanent(err) || lastAttempt) await settleAdsUpload(job.data, false);
    if (isPermanent(err)) throw new UnrecoverableError((err as Error).message);
    throw err;
  }
  await settleAdsUpload(job.data, true);
}
