// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { STRIPE_WEBHOOK_RESULTS } from "@shared/types/stripe-webhook.js";
import * as publicApi from "@shared/index.js";

describe("Stripe webhook result contract", () => {
  it("exports the complete finite result set through the public barrel", () => {
    expect(STRIPE_WEBHOOK_RESULTS).toEqual([
      "credits_granted", "credits_replay", "credits_noop", "credits_expired",
      "credits_payment_failed", "credits_mismatch", "credits_unknown",
      "membership_applied", "membership_replay", "membership_acknowledged",
      "membership_no_account", "membership_unknown_price", "membership_no_subscription",
      "membership_price_disagreement", "refund_synced", "refund_no_target",
      "refund_unreadable", "ignored", "handler_exception",
    ]);
    expect(new Set(STRIPE_WEBHOOK_RESULTS).size).toBe(19);
    expect(publicApi.STRIPE_WEBHOOK_RESULTS).toBe(STRIPE_WEBHOOK_RESULTS);
    expect(STRIPE_WEBHOOK_RESULTS).not.toContain("unfinished");
  });
});
