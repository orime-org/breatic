// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload a queued ad conversion (inner#1442 design §4.9). The platform sits
 * behind `AdsConversionSink`; Google's Data Manager API is the one sink today.
 */

import { UnrecoverableError, type Job } from "bullmq";
import { IngestionServiceClient } from "@google-ads/datamanager";
import {
  ADS_SWEEP_JOB,
  adsAllowedFor,
  AdsConversionJobSchema,
  adsConversionConfig,
  getUploadStatus,
  requeueStaleAdsUploads,
  settleAdsRefused,
  settleAdsUpload,
  type AdsConversionConfig,
  type AdsConversionJob,
} from "@breatic/core";

/** Where conversions are reported. */
export interface AdsConversionSink {
  /**
   * Send one conversion.
   * @param job - The upload.
   * @param conversionActionId - The platform's id for the conversion action.
   * @returns The platform's id for the accepted request.
   */
  upload(job: AdsConversionJob, conversionActionId: string): Promise<string | undefined>;
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
      const [response] = await client.ingestEvents({
        destinations: [{ operatingAccount: account, loginAccount: account, productDestinationId: conversionActionId }],
        // Only conversions `adsAllowed` lets through are uploaded (design §4.4.6); ads are for measurement, never personalisation.
        consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_DENIED" },
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
      return response.requestId ?? undefined;
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
 * @param sink - Builds where it goes from the configuration the conversion was checked against.
 * @throws {UnrecoverableError} When the job does not parse, ad conversions are
 *   no longer configured, or the platform refused it for good.
 * @throws {unknown} When the upload failed otherwise, so the queue retries.
 */
export async function runAdsConversion(
  job: Job<AdsConversionJob>,
  sink: (config: AdsConversionConfig) => AdsConversionSink,
): Promise<void> {
  if (job.name === ADS_SWEEP_JOB) {
    await requeueStaleAdsUploads();
    return;
  }
  if (!AdsConversionJobSchema.safeParse(job.data).success) {
    // Marked failed so the sweep does not queue the same unreadable job again.
    await settleAdsUpload(job.data, false);
    throw new UnrecoverableError("the queued conversion does not parse");
  }
  const config = adsConversionConfig();
  const actionId = config?.actions[job.data.conversion];
  if (config === null || actionId === undefined) {
    await settleAdsUpload(job.data, false);
    throw new UnrecoverableError(`no conversion action for ${job.data.conversion}`);
  }
  let requestId: string | undefined;
  try {
    // A job queued again after its upload settled (the sweep racing the last attempt) uploads nothing.
    const status = await getUploadStatus({ conversion: job.data.conversion, transactionId: job.data.transactionId });
    if (status !== "queued") return;
    // Consent may have been withdrawn since the conversion was queued (design §4.9, last column).
    if (!(await adsAllowedFor(job.data.userId, job.data.browser))) {
      await settleAdsRefused(job.data);
      return;
    }
    requestId = await sink(config).upload(job.data, actionId);
  } catch (err) {
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const permanent = err instanceof UnrecoverableError || isPermanent(err);
    if (permanent || lastAttempt) await settleAdsUpload(job.data, false);
    if (permanent) throw err instanceof UnrecoverableError ? err : new UnrecoverableError((err as Error).message);
    throw err;
  }
  await settleAdsUpload(job.data, true, requestId);
}
