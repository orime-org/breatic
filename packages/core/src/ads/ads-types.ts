// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { AdClick } from "@breatic/shared";

/** The conversions the product reports, each a conversion action in Google Ads. */
export const ADS_CONVERSIONS = ["signup", "first_project", "collaboration", "credit_purchase", "subscription"] as const;
export type AdsConversionName = (typeof ADS_CONVERSIONS)[number];

/** Where an upload stands (inner#1442 design §4.9 state table). */
export const ADS_UPLOAD_STATUSES = ["queued", "uploaded", "failed", "restating", "restated", "restate_failed"] as const;
export type AdsUploadStatus = (typeof ADS_UPLOAD_STATUSES)[number];

/** One upload, as the worker receives it. */
export interface AdsConversionJob {
  /** `conversion` uploads a new conversion; `restatement` sets its value to zero. */
  readonly kind: "conversion" | "restatement";
  readonly conversion: AdsConversionName;
  /** Shared with the browser tag, which is how Google counts the two once. */
  readonly transactionId: string;
  readonly occurredAt: string;
  readonly click: AdClick;
  readonly value?: { readonly amountCents: number; readonly currency: string };
}
