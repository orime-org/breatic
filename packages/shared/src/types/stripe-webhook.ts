// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Synchronous product handling results saved for one verified webhook attempt. */
export const STRIPE_WEBHOOK_RESULTS = [
  "credits_granted",
  "credits_replay",
  "credits_noop",
  "credits_expired",
  "credits_payment_failed",
  "credits_mismatch",
  "credits_unknown",
  "membership_applied",
  "membership_replay",
  "membership_acknowledged",
  "membership_no_account",
  "membership_unknown_price",
  "membership_no_subscription",
  "membership_price_disagreement",
  "refund_synced",
  "refund_no_target",
  "refund_unreadable",
  "ignored",
  "handler_exception",
] as const;

/** One completed handler outcome; an unfinished attempt stores null. */
export type StripeWebhookResult = typeof STRIPE_WEBHOOK_RESULTS[number];
