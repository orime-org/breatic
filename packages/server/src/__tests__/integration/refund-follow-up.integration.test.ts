// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a committed disposition reports (inner#1442 design §4.8, §4.9), on
 * real Postgres and Redis: a disposition that booked the refund sends
 * `refund_completed` under the account's latest reported consent; one that
 * did not book reports nothing.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// `ai` is stubbed so the module graph reaches no network.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

// Stripe answers from the in-memory fake, so the real disposition paths run.
vi.mock("@server/infra/stripe.js", async () => {
  const { fakeStripe } = await import("./fake-stripe-refunds.js");
  return {
    getStripeClient: () => fakeStripe.client,
    verifyWebhookSignature: () => {
      throw new Error("not used by this suite");
    },
  };
});

import crypto from "node:crypto";
import { initServerAnalytics, resetServerAnalyticsForTest, type OutgoingEvent } from "@breatic/core";
import { CONSENT_REVISION } from "@breatic/shared";
import { requestOneShot } from "@server/modules/credit-refund/disposition.service.js";
import { reportRefundOutcome } from "@server/modules/credit-refund/refund-follow-up.js";
import { handleRefundEvent, type RefundEvent } from "@server/modules/credit-refund/refund-webhook.js";
import { settleAfterReply } from "@server/utils/after-reply.js";
import {
  CREDITS,
  PAID_CENTS,
  reId,
  refundEvent,
  refundObject,
  seedOperation,
  seedRefundLot,
  useRefundSuite,
  type LotState,
  type SeededLot,
} from "./credit-refund-fixtures.js";
import { fakeStripe } from "./fake-stripe-refunds.js";

const suite = useRefundSuite("refund-follow-up-test-driver");
const sent: OutgoingEvent[] = [];

beforeAll(() => {
  initServerAnalytics({
    apiKey: "0123456789abcdef0123456789abcdef",
    createClient: () => ({ track: (event) => void sent.push(event), flush: async () => undefined }),
  });
});

beforeEach(() => {
  sent.splice(0);
  fakeStripe.reset();
});

afterAll(() => {
  resetServerAnalyticsForTest();
});

/**
 * A lot whose account last reported analytics and ads consent.
 * @param state - Where the lot stands; refunded unless a path still has to book it.
 * @returns The lot.
 */
async function refundedPurchase(state: LotState = "refunded"): Promise<SeededLot> {
  const lot = await seedRefundLot(suite.sql, state);
  await suite.sql`UPDATE users SET consent_seen = ${suite.sql.json({
    analytics: { value: true, revision: CONSENT_REVISION },
    ads: { value: true, revision: CONSENT_REVISION },
    reportedAt: new Date().toISOString(),
  })} WHERE id = ${lot.userId}`;
  return lot;
}

describe("reportRefundOutcome", () => {
  it("sends refund_completed for a disposition that booked the refund", async () => {
    const lot = await refundedPurchase();
    const op = await seedOperation(suite.sql, lot, { kind: "settle", status: "succeeded", result: "refunded" });
    await suite.sql`UPDATE credit_refund_operations SET settled_succeeded_cents = ${PAID_CENTS} WHERE id = ${op.id}`;

    await reportRefundOutcome(op.id);

    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "refund_completed",
        user_id: lot.userId,
        insert_id: `refund:${lot.lotId}`,
        event_properties: expect.objectContaining({ credits: CREDITS, amount_cents: PAID_CENTS, currency: "usd" }),
      }),
    ]);
  });

  it("reports nothing for a disposition that did not book the refund", async () => {
    const lot = await refundedPurchase();
    const op = await seedOperation(suite.sql, lot, { kind: "resolve_outside", status: "succeeded", result: "resolved_outside" });

    await reportRefundOutcome(op.id);

    expect(sent).toEqual([]);
  });
});

describe("the dispositions that book a refund report it after they commit", () => {
  /**
   * What the follow-up left once it ran.
   * @param lot - The lot.
   */
  async function expectReported(lot: SeededLot): Promise<void> {
    await settleAfterReply();
    expect(sent).toContainEqual(
      expect.objectContaining({ event_type: "refund_completed", user_id: lot.userId, insert_id: `refund:${lot.lotId}` }),
    );
  }

  it("resolve_outside on a lot whose refund succeeded on Stripe", async () => {
    const lot = await refundedPurchase("refunding");
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refundObject(reId("outside"), "succeeded", PAID_CENTS)]);
    await requestOneShot(
      "resolve_outside",
      { lotId: lot.lotId, adminId: "admin_follow_up", key: `follow-up-${crypto.randomUUID()}`, hash: "e".repeat(64), reason: "booked outside" },
      { confirmedSucceededCents: PAID_CENTS, failedRefundIds: [] },
    );
    await expectReported(lot);
  });

  it("an approval booked by Stripe's refund event", async () => {
    const lot = await refundedPurchase("refunding");
    const approve = await seedOperation(suite.sql, lot, { kind: "approve", status: "awaiting_stripe", attemptCount: 1, firstCalledHoursAgo: 0 });
    const refund = refundObject(reId("booked"), "succeeded", PAID_CENTS, approve.id);
    await suite.sql`UPDATE credit_refund_operations SET stripe_refund_id = ${refund.id} WHERE id = ${approve.id}`;
    fakeStripe.register(lot.paymentIntentId, PAID_CENTS, [refund]);
    expect(await handleRefundEvent(refundEvent("refund.updated", refund, lot.paymentIntentId) as unknown as RefundEvent)).toBe("synced");
    await expectReported(lot);
  });
});
