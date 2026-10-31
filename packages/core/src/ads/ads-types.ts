// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { BrowserAdsSnapshotSchema, type AdClick, type BrowserAdsSnapshot } from "@breatic/shared";

/** The conversions the product reports, each a conversion action in Google Ads. */
export const ADS_CONVERSIONS = ["signup", "first_project", "collaboration", "credit_purchase", "subscription"] as const;
export type AdsConversionName = (typeof ADS_CONVERSIONS)[number];

/** Where an upload stands (inner#1442 design §4.9 state table). */
export const ADS_UPLOAD_STATUSES = ["queued", "uploaded", "failed"] as const;
export type AdsUploadStatus = (typeof ADS_UPLOAD_STATUSES)[number];

/** One upload, as the worker receives it. */
export interface AdsConversionJob {
  /** The account the conversion is credited to; its consent is checked again before upload. */
  readonly userId: string;
  /** The browser behind the conversion, as it stood then; null when none was (inner#1442 §4.4.6). */
  readonly browser: BrowserAdsSnapshot | null;
  readonly conversion: AdsConversionName;
  /** Shared with the browser tag, which is how Google counts the two once. */
  readonly transactionId: string;
  readonly occurredAt: string;
  readonly click: AdClick;
  readonly value?: { readonly amountCents: number; readonly currency: string };
}

/** Name of the recurring job that queues again uploads whose job was lost. */
export const ADS_SWEEP_JOB = "sweep";

/** Why an upload stopped short of the platform, kept on its row. */
export const ADS_FAILURE_REASONS = ["consent_withdrawn"] as const;
export type AdsFailureReason = (typeof ADS_FAILURE_REASONS)[number];

const isoTime = z.string().datetime({ offset: true });

/** A queued or stored job, checked before the worker uploads it. */
export const AdsConversionJobSchema: z.ZodType<AdsConversionJob> = z
  .object({
    userId: z.string().uuid(),
    browser: BrowserAdsSnapshotSchema.nullable(),
    conversion: z.enum(ADS_CONVERSIONS),
    // Google Ads caps a transaction id at 64 characters.
    transactionId: z.string().min(1).max(64),
    occurredAt: isoTime,
    click: z
      .object({ gclid: z.string().optional(), gbraid: z.string().optional(), wbraid: z.string().optional(), at: isoTime })
      .strict(),
    value: z.object({ amountCents: z.number().int(), currency: z.string().min(3) }).strict().optional(),
  })
  .strict();
