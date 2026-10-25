// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../../../core/src/config/schema.js";
import { realStripeTestConfig } from "./real-stripe-config.js";

describe("real Stripe fixture deployment identity", () => {
  it.each([
    {},
    { STRIPE_WEBHOOK_ACCOUNT_ID: "", STRIPE_WEBHOOK_ENDPOINT_ID: "" },
    { STRIPE_WEBHOOK_ACCOUNT_ID: "   ", STRIPE_WEBHOOK_ENDPOINT_ID: "   " },
    { STRIPE_WEBHOOK_ACCOUNT_ID: "acct_Previous132", STRIPE_WEBHOOK_ENDPOINT_ID: "we_Previous132" },
  ])("constructs the actual account and unknown CLI endpoint over inherited %j", async inherited => {
    const input = { DATABASE_URL: "postgres://localhost/fixture", ...inherited };
    const retrieve = vi.fn().mockResolvedValue({ id: "acct_Actual132" });
    const configured = await realStripeTestConfig({ accounts: { retrieve } }, input);
    const parsed = parseConfig(configured);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(configured.STRIPE_WEBHOOK_ACCOUNT_ID).toBe("acct_Actual132");
    expect(parsed.STRIPE_WEBHOOK_ACCOUNT_ID).toBe("acct_Actual132");
    expect(parsed.STRIPE_WEBHOOK_ENDPOINT_ID).toBeUndefined();
    expect(configured.DATABASE_URL).toBe(input.DATABASE_URL);
    expect(input).toEqual({ DATABASE_URL: "postgres://localhost/fixture", ...inherited });
  });

  it("propagates an account lookup failure before configuring the receiver", async () => {
    const error = new Error("controlled account lookup failure");
    const retrieve = vi.fn().mockRejectedValue(error);
    await expect(realStripeTestConfig({ accounts: { retrieve } }, {})).rejects.toBe(error);
  });
});
