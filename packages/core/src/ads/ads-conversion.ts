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
 * consent again and uploads it.
 */

import { z } from "zod";
import { CLICK_WINDOW_MS, type AdClick, type BrowserAdsSnapshot } from "@breatic/shared";
import { adsAllowedFor } from "@core/analytics/account.repo.js";
import { currentAdsBrowser } from "@core/analytics/consent-context.js";
import { createHash } from "node:crypto";
import {
  claimUpload,
  findStaleUploads,
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
 * The queue's job id for an upload: one per conversion and transaction, so
 * adding it again while it is still queued does nothing.
 * @param job - The upload.
 * @returns The id (BullMQ refuses `:` in custom ids, so the key is hashed).
 */
function jobIdOf(job: AdsConversionJob): string {
  return createHash("sha256").update(`${job.conversion}\n${job.transactionId}`).digest("hex");
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
 * Put a job on the queue. Callers have already claimed the upload's row,
 * which is what makes each conversion queue once.
 * @param job - The upload.
 */
async function addJob(job: AdsConversionJob): Promise<void> {
  await adsQueue().add("conversion", job, {
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
 * @param input.paymentId - The credit order it is for.
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
 * Record how a conversion upload ended; called by the worker.
 * @param job - The upload.
 * @param uploaded - True when Google accepted it; false once retries are exhausted.
 * @param requestId - Google's id for the accepted request.
 * @throws {unknown} When the database cannot be reached.
 */
export async function settleAdsUpload(job: AdsConversionJob, uploaded: boolean, requestId?: string): Promise<void> {
  const key = { conversion: job.conversion, transactionId: job.transactionId };
  await moveUpload(key, ["queued"], uploaded ? "uploaded" : "failed", uploaded ? { requestId } : {});
}

/**
 * Record that an upload was stopped because ads are no longer allowed for it;
 * called by the worker before it uploads (design §4.9, last column).
 * @param job - The upload.
 * @throws {unknown} When the database cannot be reached.
 */
export async function settleAdsRefused(job: AdsConversionJob): Promise<void> {
  const key = { conversion: job.conversion, transactionId: job.transactionId };
  await moveUpload(key, ["queued"], "failed", { failureReason: "consent_withdrawn" });
}

/** How long a row may wait in a queued state before its job is presumed lost. */
const STALE_AFTER_MS = 10 * 60_000;

/**
 * Queue again every upload still waiting whose job was lost: the add failed
 * after the row was claimed, or the process died in between. Jobs still in
 * the queue keep their id, so re-adding them does nothing; a job the queue
 * gave up on while its outcome could not be recorded is replaced.
 * @param staleAfterMs - How long a row may wait before it counts as lost.
 * @returns How many uploads were looked at.
 * @throws {unknown} When the database or the queue cannot be reached.
 */
export async function requeueStaleAdsUploads(staleAfterMs: number = STALE_AFTER_MS): Promise<number> {
  const rows = await findStaleUploads(["queued"], new Date(Date.now() - staleAfterMs));
  for (const row of rows) {
    const existing = await adsQueue().getJob(jobIdOf(row.job));
    if (existing && (await existing.isFailed())) await existing.remove();
    await addJob(row.job);
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
