// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a committed disposition reports beyond the buyer's mails (inner#1442
 * design §4.8, §4.9): a disposition that booked the refund sends
 * `refund_completed` under the account's latest reported consent; the ad
 * conversion is left as uploaded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const core = vi.hoisted(() => ({
  accountOnlyConsent: vi.fn(),
  trackServerEvent: vi.fn(),
}));
vi.mock("@breatic/core", () => ({ ...core, logger }));

const findById = vi.fn();
vi.mock("@server/modules/credit-refund/operation.repo.js", () => ({ findById: (...a: unknown[]) => findById(...a) }));
const findLotById = vi.fn();
vi.mock("@breatic/domain", () => ({ creditLotRepo: { findLotById: (...a: unknown[]) => findLotById(...a) } }));
const readPaidAmount = vi.fn();
vi.mock("@server/modules/payment/payment.repo.js", () => ({
  readPaidAmount: (...a: unknown[]) => readPaidAmount(...a),
}));

const { reportRefundOutcome } = await import("@server/modules/credit-refund/refund-follow-up.js");

const OP = {
  id: "op-1",
  lotId: "lot-1",
  paymentId: "pay-1",
  kind: "settle",
  status: "succeeded",
  settledSucceededCents: 1080,
};
const SEEN = { analytics: true, ads: true };

beforeEach(() => {
  vi.clearAllMocks();
  findLotById.mockResolvedValue({ id: "lot-1", userId: "user-1", purchasedCredits: "880" });
  readPaidAmount.mockResolvedValue({ paidCents: 1080, currency: "usd" });
  core.accountOnlyConsent.mockResolvedValue(SEEN);
});

describe("a disposition that booked the refund", () => {
  it.each(["settle", "resolve_outside", "approve", "retry"])(
    "sends refund_completed under the account's latest reported consent (%s)",
    async (kind) => {
      findById.mockResolvedValue({ ...OP, kind });
      await reportRefundOutcome("op-1");
      expect(core.trackServerEvent).toHaveBeenCalledWith(
        "refund_completed",
        { userId: "user-1", insertId: "refund:lot-1", properties: { credits: 880, amount_cents: 1080, currency: "usd" } },
        SEEN,
      );
      expect(core.accountOnlyConsent).toHaveBeenCalledWith("user-1");
    },
  );

  it("logs an event that cannot be sent", async () => {
    findById.mockResolvedValue(OP);
    core.accountOnlyConsent.mockRejectedValue(new Error("db down"));
    await reportRefundOutcome("op-1");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op-1" }), "refund_completed_failed");
  });
});

describe("a disposition that did not book the refund", () => {
  it.each([
    ["one still running", { status: "awaiting_stripe", settledSucceededCents: null }],
    ["one needing attention", { status: "needs_attention", settledSucceededCents: null }],
    ["a rejection", { kind: "reject", settledSucceededCents: null }],
    ["a send back", { kind: "send_back", settledSucceededCents: null }],
    ["a resolve outside on a lot already booked", { kind: "resolve_outside", settledSucceededCents: null }],
    ["restoring credits", { kind: "restore_credits", settledSucceededCents: null }],
  ])("reports nothing for %s", async (_label, over) => {
    findById.mockResolvedValue({ ...OP, ...over });
    await reportRefundOutcome("op-1");
    expect(core.trackServerEvent).not.toHaveBeenCalled();
  });

  it("reports nothing for a disposition that is gone", async () => {
    findById.mockResolvedValue(null);
    await reportRefundOutcome("op-1");
    expect(core.trackServerEvent).not.toHaveBeenCalled();
  });
});
