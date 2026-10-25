// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "@core/config/schema.js";

const readFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof Fs>(),
  readFileSync: readFile,
}));

afterEach(() => {
  readFile.mockReset();
  vi.resetModules();
});

describe("Stripe webhook deployment identity", () => {
  it.each([undefined, "", "   "])("keeps missing identity unknown for %s", (value) => {
    const parsed = parseConfig({ DATABASE_URL: "postgres://localhost/test", ...(value === undefined ? {} : { STRIPE_WEBHOOK_ACCOUNT_ID: value, STRIPE_WEBHOOK_ENDPOINT_ID: value }) });
    expect(parsed.STRIPE_WEBHOOK_ACCOUNT_ID).toBeUndefined();
    expect(parsed.STRIPE_WEBHOOK_ENDPOINT_ID).toBeUndefined();
  });

  it("preserves the configured account and endpoint independently", () => {
    const parsed = parseConfig({ DATABASE_URL: "postgres://localhost/test", STRIPE_WEBHOOK_ACCOUNT_ID: " acct_Test123 ", STRIPE_WEBHOOK_ENDPOINT_ID: " we_Test456 " });
    expect(parsed.STRIPE_WEBHOOK_ACCOUNT_ID).toBe("acct_Test123");
    expect(parsed.STRIPE_WEBHOOK_ENDPOINT_ID).toBe("we_Test456");
  });

  it("accepts the complete identifier length bound", () => {
    const parsed = parseConfig({ DATABASE_URL: "postgres://localhost/test", STRIPE_WEBHOOK_ACCOUNT_ID: `acct_${"a".repeat(250)}`, STRIPE_WEBHOOK_ENDPOINT_ID: `we_${"b".repeat(252)}` });
    expect(parsed.STRIPE_WEBHOOK_ACCOUNT_ID).toHaveLength(255);
    expect(parsed.STRIPE_WEBHOOK_ENDPOINT_ID).toHaveLength(255);
  });

  it.each([
    ["STRIPE_WEBHOOK_ACCOUNT_ID", "unknown"],
    ["STRIPE_WEBHOOK_ACCOUNT_ID", "we_Test123"],
    ["STRIPE_WEBHOOK_ENDPOINT_ID", "acct_Test123"],
    ["STRIPE_WEBHOOK_ENDPOINT_ID", "we_"],
    ["STRIPE_WEBHOOK_ACCOUNT_ID", "acct_with spaces"],
    ["STRIPE_WEBHOOK_ACCOUNT_ID", `acct_${"x".repeat(251)}`],
    ["STRIPE_WEBHOOK_ENDPOINT_ID", `we_${"x".repeat(253)}`],
  ])("rejects malformed identity %s", (key, value) => {
    expect(() => parseConfig({ DATABASE_URL: "postgres://localhost/test", [key]: value })).toThrow();
  });
});

describe("Stripe webhook recording budget", () => {
  it("loads YAML lazily and memoizes the validated budget", async () => {
    readFile.mockReturnValue("write_statement_timeout_ms: 3456");
    const { getStripeWebhookRecordingWriteTimeoutMs } = await import("@core/config/stripe-webhook-recording.js");
    expect(readFile).toHaveBeenCalledTimes(0);
    expect(getStripeWebhookRecordingWriteTimeoutMs()).toBe(3456);
    expect(getStripeWebhookRecordingWriteTimeoutMs()).toBe(3456);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("uses the schema default when YAML omits the budget", async () => {
    readFile.mockReturnValue("{}");
    const { getStripeWebhookRecordingWriteTimeoutMs } = await import("@core/config/stripe-webhook-recording.js");
    expect(getStripeWebhookRecordingWriteTimeoutMs()).toBe(2000);
  });

  it.each([0, -1, 0.5, "fast"])("rejects an invalid statement budget %s", async (value) => {
    readFile.mockReturnValue(`write_statement_timeout_ms: ${value}`);
    const { getStripeWebhookRecordingWriteTimeoutMs } = await import("@core/config/stripe-webhook-recording.js");
    expect(() => getStripeWebhookRecordingWriteTimeoutMs()).toThrow();
  });
});
