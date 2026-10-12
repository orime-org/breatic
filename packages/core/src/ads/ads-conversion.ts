// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ad conversions reported to the ad platform from the backend (inner#1442
 * design §4.9).
 *
 * Off unless the deployment sets all three `GOOGLE_ADS_*` /
 * `GOOGLE_DATA_MANAGER_CREDENTIALS` values. A conversion is queued only when
 * the browser behind it accepted ads and the account or order carries a click
 * from the last 90 days; the worker uploads it. Credit purchases also keep an
 * upload state on the order, because a refund restates the value and a
 * restatement whose transaction id Google has not seen counts as a new
 * conversion.
 */

import { z } from "zod";
import { CLICK_WINDOW_MS, type AdClick, type ConsentSnapshot } from "@breatic/shared";
import { currentConsent } from "@core/analytics/consent-context.js";
import { claimUpload, findUploadByPayment, moveUpload } from "@core/ads/ads-conversion.repo.js";
import { ADS_CONVERSIONS, type AdsConversionJob, type AdsConversionName } from "@core/ads/ads-types.js";
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
 * Put a job on the queue. Callers have already claimed the upload's row, which
 * is what makes each conversion and each restatement queue once.
 * @param job - The upload.
 */
async function addJob(job: AdsConversionJob): Promise<void> {
  queue ??= createQueue(ADS_CONVERSION_QUEUE);
  await queue.add(job.kind, job, {
    ...defaultJobOpts(),
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
  });
}

/**
 * Whether a conversion would be queued, before its click is looked up.
 * @param conversion - The conversion.
 * @param consent - The choice of the browser behind it; defaults to the request's.
 * @returns True when the browser accepted ads and the conversion has a configured action.
 */
export function adsConversionWanted(
  conversion: AdsConversionName,
  consent: ConsentSnapshot = currentConsent(),
): boolean {
  return consent.ads && adsConversionConfig()?.actions[conversion] !== undefined;
}

/**
 * Queue a conversion for upload, once per conversion and transaction id.
 * @param input - The conversion.
 * @param input.conversion - Which conversion action it counts toward.
 * @param input.transactionId - Shared with the browser tag for deduplication.
 * @param input.click - The click it is credited to (`adClickFrom`); none means nothing to upload.
 * @param input.value - Revenue, for purchases.
 * @param input.value.amountCents - Amount in the currency's minor unit.
 * @param input.value.currency - ISO currency code.
 * @param input.paymentId - The credit order, which a refund restates by.
 * @param consent - The choice of the browser behind it; defaults to the request's.
 * @returns Whether it was queued.
 * @throws {unknown} When the database or the queue cannot be reached; callers log and carry on.
 */
export async function enqueueAdsConversion(
  input: {
    conversion: AdsConversionName;
    transactionId: string;
    click: AdClick | null;
    value?: { amountCents: number; currency: string };
    paymentId?: string;
  },
  consent: ConsentSnapshot = currentConsent(),
): Promise<boolean> {
  if (!adsConversionWanted(input.conversion, consent)) return false;
  const { click } = input;
  if (click === null || Date.now() - Date.parse(click.at) > CLICK_WINDOW_MS) return false;
  const job: AdsConversionJob = {
    kind: "conversion",
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
 * Queue the zero-value restatement of a refunded credit purchase. Only a
 * conversion that is queued or uploaded is restated: one Google never
 * received would be counted as a new conversion. A restatement of one still
 * queued waits in the worker until the upload settles.
 * @param paymentId - The refunded order.
 * @returns Whether a restatement was queued.
 * @throws {unknown} When the database or the queue cannot be reached.
 */
export async function enqueueAdsRestatement(paymentId: string): Promise<boolean> {
  if (adsConversionConfig() === null) return false;
  const upload = await findUploadByPayment(paymentId);
  if (!upload) return false;
  const { conversion, transactionId } = upload.job;
  if (!(await moveUpload({ conversion, transactionId }, ["queued", "uploaded"], "restating"))) return false;
  await addJob({
    ...upload.job,
    kind: "restatement",
    value: { amountCents: 0, currency: upload.job.value?.currency ?? "USD" },
  });
  return true;
}

/**
 * Replace the configuration in tests; `undefined` re-reads it from env.
 * @param config - The configuration to use, null for off.
 */
export function setAdsConversionConfigForTest(config: AdsConversionConfig | null | undefined): void {
  parsed = config === undefined ? undefined : { config, state: config ? "on" : "off" };
}
