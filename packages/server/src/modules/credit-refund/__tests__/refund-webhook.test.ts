// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ payment: vi.fn(), lot: vi.fn(), lock: vi.fn(), claim: vi.fn(), list: vi.fn(), apply: vi.fn(), follow: vi.fn() }));
vi.mock("@breatic/core", () => ({ db: { transaction: async (callback: (tx: object) => Promise<unknown>) => callback({}) }, logger: { error: vi.fn() } }));
vi.mock("@breatic/domain", () => ({ creditLotRepo: { findLotIdByPayment: mocked.lot, lockLot: mocked.lock } }));
vi.mock("@server/modules/payment/payment.repo.js", () => ({ findIdByPaymentIntent: mocked.payment }));
vi.mock("@server/modules/subscription/webhook-events.repo.js", () => ({ claimWebhookEvent: mocked.claim }));
vi.mock("@server/modules/credit-refund/refund-follow-up.js", () => ({ followUpOperationLater: mocked.follow }));
vi.mock("@server/modules/credit-refund/refund-snapshot.js", () => ({ applyRefundSnapshot: mocked.apply }));
vi.mock("@server/modules/credit-refund/stripe-refunds.js", () => ({ listRefunds: mocked.list, StripeReadError: class extends Error {} }));
import { handleRefundEvent } from "@server/modules/credit-refund/refund-webhook.js";
import { StripeReadError } from "@server/modules/credit-refund/stripe-refunds.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocked.payment.mockResolvedValue("payment_refund");
  mocked.lot.mockResolvedValue("lot_refund");
  mocked.list.mockResolvedValue([]);
  mocked.apply.mockResolvedValue(null);
});

describe("refund webhook processing classification", () => {
  it.each(["intent", "payment", "lot"])("keeps the existing claim for missing %s and reports no local target", async missing => {
    if (missing === "payment") mocked.payment.mockResolvedValue(null);
    if (missing === "lot") mocked.lot.mockResolvedValue(null);
    const input = { id: "evt_refund", type: "refund.failed", data: { object: { payment_intent: missing === "intent" ? null : "pi_refund" } } };
    expect(await handleRefundEvent(input)).toBe("no_target");
    expect(mocked.claim).toHaveBeenCalledWith("evt_refund", "refund.failed", {});
    expect(mocked.list).toHaveBeenCalledTimes(0);
  });
  it("reports the saved snapshot even when the original event is refund.failed", async () => {
    expect(await handleRefundEvent({ id: "evt_refund", type: "refund.failed", data: { object: { payment_intent: "pi_refund" } } })).toBe("synced");
    expect(mocked.lock).toHaveBeenCalledWith("lot_refund", {});
    expect(mocked.apply).toHaveBeenCalledWith({}, "payment_refund", [], "webhook");
    expect(mocked.claim).toHaveBeenCalledTimes(1);
  });
  it("reports an unreadable Stripe source before any claim", async () => {
    mocked.list.mockRejectedValue(new StripeReadError("controlled"));
    expect(await handleRefundEvent({ id: "evt_refund", type: "refund.updated", data: { object: { payment_intent: "pi_refund" } } })).toBe("unreadable");
    expect(mocked.claim).toHaveBeenCalledTimes(0);
  });
});
