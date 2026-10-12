// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload a queued ad conversion (inner#1442 design §4.9). The platform sits
 * behind `AdsConversionSink`; Google's Data Manager API is the one sink today.
 */

import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import { IngestionServiceClient } from "@google-ads/datamanager";
import {
  ADS_SWEEP_JOB,
  adsConversionConfig,
  getUploadStatus,
  requeueStaleAdsUploads,
  settleAdsUpload,
  type AdsConversionConfig,
  type AdsConversionJob,
  type AdsUploadStatus,
} from "@breatic/core";

/** How the platform's processing of an accepted request ended. */
export type UploadProcessing = "success" | "processing" | "failed";

/** Where conversions are reported. */
export interface AdsConversionSink {
  /**
   * Send one conversion or restatement.
   * @param job - The upload.
   * @param conversionActionId - The platform's id for the conversion action.
   * @returns The platform's id for the accepted request.
   */
  upload(job: AdsConversionJob, conversionActionId: string): Promise<string | undefined>;
  /**
   * How processing of an accepted request ended; acceptance alone does not
   * mean the platform recorded the conversion.
   * @param requestId - The id `upload` returned.
   * @returns The outcome.
   */
  status(requestId: string): Promise<UploadProcessing>;
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
        // Only browsers that accepted ads are queued (design §4.4.5); ads are for measurement, never personalisation.
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
    async status(requestId) {
      const [response] = await client.retrieveRequestStatus({ requestId });
      const outcome = response.requestStatusPerDestination?.[0]?.requestStatus;
      if (outcome === "SUCCESS" || outcome === "PARTIAL_SUCCESS") return "success";
      if (outcome === "FAILED") return "failed";
      return "processing";
    },
  };
}

// Google's schedule for polling a request it is still processing: first check
// 30 minutes after ingestion, backoff ×1.3 capped at an hour, give up after a
// day, with a little jitter (Data Manager API diagnostics guide).
const STATUS_FIRST_WAIT_MS = 30 * 60_000;
const STATUS_MAX_WAIT_MS = 60 * 60_000;
const STATUS_BACKOFF = 1.3;
const STATUS_JITTER = 0.1;
const STATUS_GIVE_UP_MS = 24 * 60 * 60_000;

/**
 * How long to wait before checking the original upload again.
 * @param checks - Checks that already found it processing.
 * @returns The wait in ms.
 */
function statusCheckWait(checks: number): number {
  const wait = Math.min(STATUS_MAX_WAIT_MS, STATUS_FIRST_WAIT_MS * STATUS_BACKOFF ** checks);
  return wait * (1 + Math.random() * STATUS_JITTER);
}

/**
 * Put a restatement back on the queue until Google has processed the
 * original upload; a delayed job spends none of its attempts.
 * @param job - The restatement.
 * @param token - The worker's lock token for the job.
 * @throws {DelayedError} Always, once the job is delayed.
 * @throws {UnrecoverableError} When the original is still processing a day on.
 */
async function waitForOriginal(job: Job<AdsConversionJob>, token: string | undefined): Promise<never> {
  if (token === undefined) throw new Error("the original upload is still processing");
  if (Date.now() - job.timestamp > STATUS_GIVE_UP_MS) {
    throw new UnrecoverableError("the original upload was still processing a day later");
  }
  const checks = job.data.statusChecks ?? 0;
  await job.updateData({ ...job.data, statusChecks: checks + 1 });
  await job.moveToDelayed(Date.now() + statusCheckWait(checks), token);
  throw new DelayedError();
}

/**
 * Whether an upload's row still waits for this job.
 * @param job - The upload.
 * @param status - Where its row stands.
 * @returns True while the row expects this job to upload.
 */
function uploadAwaited(job: AdsConversionJob, status: AdsUploadStatus): boolean {
  return job.kind === "restatement" ? status === "restating" : status === "queued" || status === "restate_pending";
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
 * @param token - The worker's lock token for the job.
 * @throws {UnrecoverableError} When ad conversions are no longer configured or
 *   the platform refused it for good.
 * @throws {DelayedError} When a restatement waits for Google to process the original.
 * @throws {unknown} When the upload failed otherwise, so the queue retries.
 */
export async function runAdsConversion(
  job: Job<AdsConversionJob>,
  sink: AdsConversionSink,
  token?: string,
): Promise<void> {
  if (job.name === ADS_SWEEP_JOB) {
    await requeueStaleAdsUploads();
    return;
  }
  const actionId = adsConversionConfig()?.actions[job.data.conversion];
  if (actionId === undefined) {
    await settleAdsUpload(job.data, false);
    throw new UnrecoverableError(`no conversion action for ${job.data.conversion}`);
  }
  let requestId: string | undefined;
  try {
    // A job queued again after its upload settled (the sweep racing the last attempt) uploads nothing.
    const status = await getUploadStatus({ conversion: job.data.conversion, transactionId: job.data.transactionId });
    if (status === null || !uploadAwaited(job.data, status)) return;
    // A restatement of a conversion Google never recorded would count as a new conversion.
    if (job.data.kind === "restatement" && job.data.originalRequestId) {
      const original = await sink.status(job.data.originalRequestId);
      if (original === "failed") throw new UnrecoverableError("the original upload was rejected");
      if (original === "processing") await waitForOriginal(job, token);
    }
    requestId = await sink.upload(job.data, actionId);
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const permanent = err instanceof UnrecoverableError || isPermanent(err);
    if (permanent || lastAttempt) await settleAdsUpload(job.data, false);
    if (permanent) throw err instanceof UnrecoverableError ? err : new UnrecoverableError((err as Error).message);
    throw err;
  }
  await settleAdsUpload(job.data, true, requestId);
}
