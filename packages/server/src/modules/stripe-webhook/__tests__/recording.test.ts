// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  const env: { ENV: string; STRIPE_WEBHOOK_ACCOUNT_ID?: string; STRIPE_WEBHOOK_ENDPOINT_ID?: string } = { ENV: "test", STRIPE_WEBHOOK_ACCOUNT_ID: "acct_configured", STRIPE_WEBHOOK_ENDPOINT_ID: "we_configured" };
  return { begin: vi.fn(), finish: vi.fn(), env };
});
vi.mock("@server/modules/stripe-webhook/attempts.repo.js", () => ({ beginAttempt: mocked.begin, finishAttempt: mocked.finish }));
vi.mock("@breatic/core", () => ({ env: mocked.env }));
import { parseWebhookIdentity, startWebhookAttempt, finishWebhookAttempt } from "@server/modules/stripe-webhook/recording.service.js";

const event = { id: "evt_record", type: "refund.failed", livemode: false, account: "acct_connected", data: { object: {} } };

beforeEach(() => {
  vi.resetAllMocks();
  mocked.env.STRIPE_WEBHOOK_ACCOUNT_ID = "acct_configured";
  mocked.env.STRIPE_WEBHOOK_ENDPOINT_ID = "we_configured";
});

describe("recordable signed webhook identity", () => {
  it("keeps signed identity and connected account separate from deployment metadata", () => {
    expect(parseWebhookIdentity(event)).toEqual({ eventId: "evt_record", eventType: "refund.failed", livemode: false, connectedAccountId: "acct_connected" });
    expect(parseWebhookIdentity({ ...event, account: undefined })).toEqual({ eventId: "evt_record", eventType: "refund.failed", livemode: false, connectedAccountId: null });
  });

  it.each([null, [], {}, { ...event, id: 1 }, { ...event, id: "" }, { ...event, id: "x".repeat(256) }, { ...event, id: "evt_\u0000" }, { ...event, type: "" }, { ...event, type: "x".repeat(81) }, { ...event, type: "refund.\u0000" }, { ...event, livemode: "false" }, { ...event, account: 2 }, { ...event, account: "" }, { ...event, account: "x".repeat(256) }, { ...event, account: "acct_\u0000" }, { ...event, data: null }, { ...event, data: { object: [] } }])("rejects identity that cannot be represented %j", value => {
    expect(parseWebhookIdentity(value)).toBeNull();
  });

  it("writes only controlled start fields with their original receipt time", async () => {
    const receivedAt = new Date("2026-10-24T08:00:00Z");
    await startWebhookAttempt("attempt-id", parseWebhookIdentity(event)!, receivedAt);
    expect(mocked.begin).toHaveBeenCalledWith({ id: "attempt-id", eventId: "evt_record", eventType: "refund.failed", livemode: false, connectedAccountId: "acct_connected", accountId: "acct_configured", endpointId: "we_configured", environment: "test", receivedAt });
  });

  it("returns the finite completion state and propagates persistence errors", async () => {
    mocked.finish.mockResolvedValue("already_finished");
    expect(await finishWebhookAttempt("attempt-id", 200, "refund_synced")).toBe("already_finished");
    expect(mocked.finish).toHaveBeenCalledWith({ id: "attempt-id", responseStatus: 200, result: "refund_synced" });
    const failure = new Error("controlled persistence failure");
    mocked.begin.mockRejectedValue(failure);
    await expect(startWebhookAttempt("attempt-id", parseWebhookIdentity(event)!, new Date())).rejects.toBe(failure);
  });

  it("persists unknown deployment identity explicitly", async () => {
    mocked.env.STRIPE_WEBHOOK_ACCOUNT_ID = undefined;
    mocked.env.STRIPE_WEBHOOK_ENDPOINT_ID = undefined;
    const receivedAt = new Date("2026-10-24T08:00:00Z");
    await startWebhookAttempt("attempt-id", parseWebhookIdentity(event)!, receivedAt);
    expect(mocked.begin).toHaveBeenCalledWith({ id: "attempt-id", eventId: "evt_record", eventType: "refund.failed", livemode: false, connectedAccountId: "acct_connected", accountId: null, endpointId: null, environment: "test", receivedAt });
  });
});
