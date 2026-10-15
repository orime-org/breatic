// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ad conversions reported to the ad platform from the backend (inner#1442
 * design §4.9).
 *
 * Off unless the deployment sets all three `GOOGLE_ADS_*` /
 * `GOOGLE_DATA_MANAGER_CREDENTIALS` values. A conversion is queued only when
 * `adsAllowed` lets ads run for the account and the browser behind it, and the
 * account or order carries a click from the last 90 days; the worker checks
 * consent again and uploads it. Credit purchases also keep an
 * upload state on the order, because a refund restates the value and a
 * restatement whose transaction id Google has not seen counts as a new
 * conversion.
 */

import { z } from "zod";
import { CLICK_WINDOW_MS, type AdClick, type BrowserAdsSnapshot } from "@breatic/shared";
import { adsAllowedFor } from "@core/analytics/account.repo.js";
import { currentAdsBrowser } from "@core/analytics/consent-context.js";
import { createHash } from "node:crypto";
import {
  claimUpload,
  findRefundedUnrestated,
  findStaleUploads,
  findUploadByPayment,
  getUploadStatus,
  moveUpload,
} from "@core/ads/ads-conversion.repo.js";
import { ADS_CONVERSIONS, ADS_SWEEP_JOB, type AdsConversionJob, type AdsConversionName } from "@core/ads/ads-types.js";
import { env } from "@core/config/env.js";
import { createQueue, defaultJobOpts } from "@core/infra/queue.js";

/** The queue conversions travel on. */
export const ADS_CONVERSION_QUEUE = "ads-conversion";

const credentialsSchema = z.object({ client_email: z.string().min(1), private_key: z.string().min(1) }).passthrough();
const actionsSchema = z.record(z.enum(ADS_CONVERSIONS), z.string().regex(/^\d+$/));

/** The parsed deployment configuration the worker uploads with. */
export interface AdsConversionConfig {
  readonly customerId: string;
  readonly actions: Partial<Record<AdsConversionName, string>>;
  readonly credentials: z.infer<typeof credentialsSchema>;
}

let parsed: { config: AdsConversionConfig | null; state: "on" | "off" | "invalid" } | undefined;

/**
 * Read the ad conversion configuration once.
 * @returns The configuration and whether it is on, off or malformed.
 */
function readConfig(): NonNullable<typeof parsed> {
  if (parsed) return parsed;
  const customerId = env.GOOGLE_ADS_CUSTOMER_ID.replaceAll("-", "");
  const rawActions = env.GOOGLE_ADS_CONVERSION_ACTIONS;
  const rawCredentials = env.GOOGLE_DATA_MANAGER_CREDENTIALS;
  if (customerId === "" && rawActions === "" && rawCredentials === "") {
    parsed = { config: null, state: "off" };
    return parsed;
  }
  try {
    const actions = actionsSchema.parse(JSON.parse(rawActions));
    const credentials = credentialsSchema.parse(JSON.parse(rawCredentials));
    if (!/^\d{10}$/.test(customerId)) throw new Error("customer id");
    parsed = { config: { customerId, actions, credentials }, state: "on" };
  } catch {
    parsed = { config: null, state: "invalid" };
  }
  return parsed;
}

/**
 * Whether ad conversions are configured, for the service entry to log.
 * @returns `on`, `off` when nothing is set, or `invalid` when the values do not parse.
 */
export function adsConversionState(): "on" | "off" | "invalid" {
  return readConfig().state;
}

/**
 * The configuration the worker uploads with.
 * @returns It, or null when ad conversions are off or malformed.
 */
export function adsConversionConfig(): AdsConversionConfig | null {
  return readConfig().config;
}

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * The queue's job id for an upload: one per conversion, transaction and kind,
 * so adding it again while it is still queued does nothing.
 * @param job - The upload.
 * @returns The id (BullMQ refuses `:` in custom ids, so the key is hashed).
 */
function jobIdOf(job: AdsConversionJob): string {
  return createHash("sha256").update(`${job.kind}\n${job.conversion}\n${job.transactionId}`).digest("hex");
}

/**
 * The ads queue, created on first use.
 * @returns The queue.
 */
function adsQueue(): ReturnType<typeof createQueue> {
  queue ??= createQueue(ADS_CONVERSION_QUEUE);
  return queue;
}

/**
 * Put a job on the queue. Callers have already claimed or moved the upload's
 * row, which is what makes each conversion and each restatement queue once.
 * @param job - The upload.
 */
async function addJob(job: AdsConversionJob): Promise<void> {
  await adsQueue().add(job.kind, job, {
    ...defaultJobOpts(),
    jobId: jobIdOf(job),
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
  });
}

/**
 * Queue a conversion for upload, once per conversion and transaction id.
 * @param input - The conversion.
 * @param input.userId - The account it is credited to.
 * @param input.conversion - Which conversion action it counts toward.
 * @param input.transactionId - Shared with the browser tag for deduplication.
 * @param input.click - The click it is credited to (`adClickFrom`); none means nothing to upload.
 * @param input.value - Revenue, for purchases.
 * @param input.value.amountCents - Amount in the currency's minor unit.
 * @param input.value.currency - ISO currency code.
 * @param input.paymentId - The credit order, which a refund restates by.
 * @param browser - The browser behind it as it stood then; defaults to the
 *   request's; null for an event no browser is behind.
 * @returns Whether it was queued.
 * @throws {unknown} When the database or the queue cannot be reached; callers log and carry on.
 */
export async function enqueueAdsConversion(
  input: {
    userId: string;
    conversion: AdsConversionName;
    transactionId: string;
    click: AdClick | null;
    value?: { amountCents: number; currency: string };
    paymentId?: string;
  },
  browser: BrowserAdsSnapshot | null = currentAdsBrowser(),
): Promise<boolean> {
  if (adsConversionConfig()?.actions[input.conversion] === undefined) return false;
  const { click } = input;
  if (click === null || Date.now() - Date.parse(click.at) > CLICK_WINDOW_MS) return false;
  if (!(await adsAllowedFor(input.userId, browser))) return false;
  const job: AdsConversionJob = {
    kind: "conversion",
    userId: input.userId,
    browser,
    conversion: input.conversion,
    transactionId: input.transactionId,
    occurredAt: new Date().toISOString(),
    click,
    ...(input.value ? { value: input.value } : {}),
  };
  if (!(await claimUpload(job, input.paymentId ?? null))) return false;
  await addJob(job);
  return true;
}

/**
 * Whether ads still may run for an upload: the account's current switch with
 * the browser as the job recorded it.
 * @param job - The upload.
 * @returns Whether it may go to the platform.
 */
function stillAllowed(job: AdsConversionJob): Promise<boolean> {
  return adsAllowedFor(job.userId, job.browser);
}

/**
 * Ask for the zero-value restatement of a refunded credit purchase. Only a
 * conversion Google received is restated: one it never saw would be counted
 * as a new conversion. A conversion still queued is marked, and the worker
 * queues the restatement once the upload lands; one whose upload failed is
 * left alone, and so is one whose account or browser no longer allows ads.
 * @param paymentId - The refunded order.
 * @returns `queued`, `after_upload` when it follows the upload still queued,
 *   `consent_withdrawn` when ads are no longer allowed (the caller logs it), or
 *   `none` when there is nothing Google received to restate.
 * @throws {unknown} When the database or the queue cannot be reached.
 */
export async function enqueueAdsRestatement(
  paymentId: string,
): Promise<"queued" | "after_upload" | "consent_withdrawn" | "none"> {
  if (adsConversionConfig() === null) return "none";
  const upload = await findUploadByPayment(paymentId);
  if (!upload) return "none";
  const key = { conversion: upload.job.conversion, transactionId: upload.job.transactionId };
  if (await moveUpload(key, ["queued"], "restate_pending")) return "after_upload";
  // Read again: the upload may have landed since the first read.
  if ((await getUploadStatus(key)) !== "uploaded") return "none";
  if (!(await stillAllowed(upload.job))) {
    // Recorded on the row, so the sweep's refund check does not ask again.
    await moveUpload(key, ["uploaded"], "uploaded", { failureReason: "consent_withdrawn" });
    return "consent_withdrawn";
  }
  if (!(await moveUpload(key, ["uploaded"], "restating"))) return "none";
  await addJob(restatementOf(upload.job, upload.requestId));
  return "queued";
}

/**
 * Take back a restatement that never went out, when a refunded order's
 * credits are restored: one still waiting on its upload is dropped, and the
 * conversion stands at full value. One already queued or sent cannot be
 * taken back (the platform cannot undo a restatement to zero).
 * @param paymentId - The order.
 * @returns `cancelled`, the state of a restatement already on its way
 *   (`restating`) or sent (`restated`), or `none` when none was asked for.
 * @throws {unknown} When the database cannot be reached.
 */
export async function cancelPendingAdsRestatement(
  paymentId: string,
): Promise<"cancelled" | "restating" | "restated" | "none"> {
  const upload = await findUploadByPayment(paymentId);
  if (!upload) return "none";
  const key = { conversion: upload.job.conversion, transactionId: upload.job.transactionId };
  if (await moveUpload(key, ["restate_pending"], "queued")) return "cancelled";
  const status = await getUploadStatus(key);
  return status === "restating" || status === "restated" ? status : "none";
}

/**
 * The zero-value restatement of an uploaded conversion.
 * @param job - The original upload.
 * @param requestId - The platform's id for the original upload.
 * @returns The restatement job.
 */
function restatementOf(job: AdsConversionJob, requestId: string | null): AdsConversionJob {
  return {
    ...job,
    kind: "restatement",
    value: { amountCents: 0, currency: job.value?.currency ?? "USD" },
    ...(requestId ? { originalRequestId: requestId } : {}),
  };
}

/**
 * Record how a conversion upload ended; called by the worker. A refund that
 * arrived while it was queued is restated now that Google has it, while ads
 * are still allowed.
 * @param job - The upload.
 * @param uploaded - True when Google accepted it; false once retries are exhausted.
 * @param requestId - Google's id for the accepted request.
 * @returns True when a waiting restatement was dropped because ads are no
 *   longer allowed, for the worker to log.
 * @throws {unknown} When the database or the queue cannot be reached.
 */
export async function settleAdsUpload(job: AdsConversionJob, uploaded: boolean, requestId?: string): Promise<boolean> {
  const key = { conversion: job.conversion, transactionId: job.transactionId };
  if (job.kind === "restatement") {
    await moveUpload(key, ["restating"], uploaded ? "restated" : "restate_failed");
    return false;
  }
  if (!uploaded) {
    await moveUpload(key, ["queued", "restate_pending"], "failed");
    return false;
  }
  if (await moveUpload(key, ["queued"], "uploaded", { requestId })) return false;
  // A refund waits on this upload; it is forwarded only while ads are still allowed.
  if (!(await stillAllowed(job))) {
    return moveUpload(key, ["restate_pending"], "uploaded", { requestId, failureReason: "consent_withdrawn" });
  }
  if (await moveUpload(key, ["restate_pending"], "restating", { requestId })) {
    await addJob(restatementOf(job, requestId ?? null));
  }
  return false;
}

/**
 * Record that an upload was stopped because ads are no longer allowed for it;
 * called by the worker before it uploads (design §4.9, last column).
 * @param job - The upload.
 * @throws {unknown} When the database cannot be reached.
 */
export async function settleAdsRefused(job: AdsConversionJob): Promise<void> {
  const key = { conversion: job.conversion, transactionId: job.transactionId };
  const failureReason = "consent_withdrawn" as const;
  if (job.kind === "restatement") {
    await moveUpload(key, ["restating"], "restate_failed", { failureReason });
    return;
  }
  await moveUpload(key, ["queued", "restate_pending"], "failed", { failureReason });
}

/** How long a row may wait in a queued state before its job is presumed lost. */
const STALE_AFTER_MS = 10 * 60_000;

/**
 * Queue again every upload still waiting whose job was lost: the add failed
 * after the row was claimed, or the process died in between. Jobs still in
 * the queue keep their id, so re-adding them does nothing; a job the queue
 * gave up on while its outcome could not be recorded is replaced. Also asks
 * for the restatement of every refunded order whose conversion still stands
 * at full value: the refund's own request runs after the reply and is not
 * retried.
 * @param staleAfterMs - How long a row may wait before it counts as lost.
 * @returns How many uploads were looked at.
 * @throws {unknown} When the database or the queue cannot be reached.
 */
export async function requeueStaleAdsUploads(staleAfterMs: number = STALE_AFTER_MS): Promise<number> {
  const staleBefore = new Date(Date.now() - staleAfterMs);
  for (const paymentId of await findRefundedUnrestated(staleBefore)) await enqueueAdsRestatement(paymentId);
  // `restate_pending` waits on its conversion's upload, so the conversion is what goes back on the queue.
  const rows = await findStaleUploads(["queued", "restate_pending", "restating"], staleBefore);
  for (const row of rows) {
    const job = row.status === "restating" ? restatementOf(row.job, row.requestId) : row.job;
    const existing = await adsQueue().getJob(jobIdOf(job));
    if (existing && (await existing.isFailed())) await existing.remove();
    await addJob(job);
  }
  return rows.length;
}

/**
 * Run {@link requeueStaleAdsUploads} on the queue every ten minutes, once
 * across all workers. Only a deployment with ad conversions configured calls this.
 */
export async function scheduleAdsUploadSweep(): Promise<void> {
  const { removeOnComplete, removeOnFail } = defaultJobOpts();
  await adsQueue().upsertJobScheduler(
    ADS_SWEEP_JOB,
    { every: STALE_AFTER_MS },
    { name: ADS_SWEEP_JOB, data: {}, opts: { removeOnComplete, removeOnFail } },
  );
}

/** Stop the sweep on a deployment whose ad conversions were switched off. */
export async function unscheduleAdsUploadSweep(): Promise<void> {
  await adsQueue().removeJobScheduler(ADS_SWEEP_JOB);
}

/**
 * Replace the configuration in tests; `undefined` re-reads it from env.
 * @param config - The configuration to use, null for off.
 */
export function setAdsConversionConfigForTest(config: AdsConversionConfig | null | undefined): void {
  parsed = config === undefined ? undefined : { config, state: config ? "on" : "off" };
}
