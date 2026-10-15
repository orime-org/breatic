// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a committed disposition reports (inner#1442 design §4.8, §4.9), on
 * real Postgres and Redis: a disposition that booked the refund sends
 * `refund_completed` under the account's last seen choice and restates the
 * order's uploaded ad conversion to zero; one that did not book reports
 * nothing.
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

import crypto from "node:crypto";
import {
  ADS_CONVERSION_QUEUE,
  createQueue,
  enqueueAdsConversion,
  getUploadStatus,
  initServerAnalytics,
  moveUpload,
  resetServerAnalyticsForTest,
  setAdsConversionConfigForTest,
  type OutgoingEvent,
} from "@breatic/core";
import { CONSENT_REVISION } from "@breatic/shared";
import { reportRefundOutcome } from "@server/modules/credit-refund/refund-follow-up.js";
import { CREDITS, PAID_CENTS, seedOperation, seedRefundLot, useRefundSuite, type SeededLot } from "./credit-refund-fixtures.js";

const suite = useRefundSuite("refund-follow-up-test-driver");
const sent: OutgoingEvent[] = [];

beforeAll(() => {
  initServerAnalytics({
    apiKey: "0123456789abcdef0123456789abcdef",
    createClient: () => ({ track: (event) => void sent.push(event), flush: async () => undefined }),
  });
  setAdsConversionConfigForTest({
    customerId: "1234567890",
    actions: { credit_purchase: "22" },
    credentials: { client_email: "svc@example.test", private_key: "key" },
  });
});

beforeEach(() => {
  sent.splice(0);
});

afterAll(async () => {
  resetServerAnalyticsForTest();
  setAdsConversionConfigForTest(undefined);
  await createQueue(ADS_CONVERSION_QUEUE).obliterate({ force: true });
});

/**
 * A refunded lot whose order's conversion Google has, and whose account last
 * chose analytics and ads while signed in.
 * @returns The lot and the conversion's transaction id.
 */
async function refundedPurchase(): Promise<{ lot: SeededLot; txn: string }> {
  const lot = await seedRefundLot(suite.sql, "refunded");
  await suite.sql`UPDATE users SET consent_seen = ${suite.sql.json({
    analytics: { value: true, revision: CONSENT_REVISION },
    ads: { value: true, revision: CONSENT_REVISION },
  })}, attribution = ${suite.sql.json({ last: { gclid: "g", at: new Date().toISOString() } })} WHERE id = ${lot.userId}`;
  const txn = `purchase:${crypto.randomUUID()}`;
  await enqueueAdsConversion(
    {
      userId: lot.userId,
      conversion: "credit_purchase",
      transactionId: txn,
      click: { gclid: "g", at: new Date().toISOString() },
      value: { amountCents: PAID_CENTS, currency: "USD" },
      paymentId: lot.paymentId,
    },
    { consent: true, gpc: false },
  );
  await moveUpload({ conversion: "credit_purchase", transactionId: txn }, ["queued"], "uploaded");
  return { lot, txn };
}

describe("reportRefundOutcome", () => {
  it("sends refund_completed and restates the conversion for a disposition that booked the refund", async () => {
    const { lot, txn } = await refundedPurchase();
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
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: txn })).toBe("restating");
  });

  it("reports nothing for a disposition that did not book the refund", async () => {
    const { lot, txn } = await refundedPurchase();
    const op = await seedOperation(suite.sql, lot, { kind: "resolve_outside", status: "succeeded", result: "resolved_outside" });

    await reportRefundOutcome(op.id);

    expect(sent).toEqual([]);
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: txn })).toBe("uploaded");
  });
});
