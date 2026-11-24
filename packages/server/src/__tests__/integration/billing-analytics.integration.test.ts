// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Purchase and subscription events (inner#1442 design §4.8, §4.9) — real PG
 * and Redis, a recording analytics client and the real ads upload queue.
 *
 * The billing service decides what a purchase or a subscription start
 * reports and under which consent (inner#1993 §3.3); the product reports it
 * once, after the grant or the fact commits, under exactly that consent.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll, inject } from "vitest";
import postgres from "postgres";
import {
  ADS_CONVERSION_QUEUE,
  createQueue,
  getUploadStatus,
  initCore,
  initServerAnalytics,
  loadLocales,
  resetServerAnalyticsForTest,
  setAdsConversionConfigForTest,
  type OutgoingEvent,
  type PaymentGrantRequest,
  type SubscriptionFactRequest,
} from "@breatic/core";
import { grantPayment } from "@server/modules/commerce/payment-grant.service.js";
import { applySubscriptionFact } from "@server/modules/commerce/commerce-subscription-facts.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
const sent: OutgoingEvent[] = [];
const recentClick = (): { gclid: string; at: string } => ({ gclid: "click-9", at: new Date().toISOString() });

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
  initServerAnalytics({
    apiKey: "0123456789abcdef0123456789abcdef",
    createClient: () => ({ track: (event) => void sent.push(event), flush: async () => undefined }),
  });
  setAdsConversionConfigForTest({
    customerId: "1234567890",
    actions: { credit_purchase: "22", subscription: "33" },
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
  await sql?.end({ timeout: 1 });
});

/**
 * One account.
 * @returns Its id.
 */
async function account(): Promise<string> {
  const userId = randomUUID();
  await sql`INSERT INTO users (id, email, email_verified) VALUES (${userId}, ${`billing-${userId}@example.test`}, true)`;
  return userId;
}

/**
 * A grant for 1700 credits bought for 2000 cents.
 * @param userId - The buyer.
 * @param conversion - The order's conversion context.
 * @returns The request.
 */
function grant(userId: string, conversion: PaymentGrantRequest["conversion"]): PaymentGrantRequest {
  return {
    userId,
    purchasedCredits: 1700,
    amountCents: 2000,
    taxCents: 240,
    totalCents: 2240,
    currency: "usd",
    orderedAt: new Date().toISOString(),
    conversion,
  };
}

describe("credit purchases", () => {
  it("reports the grant once, under the order's consent, and queues its conversion", async () => {
    const userId = await account();
    const paymentId = randomUUID();
    const transactionId = `purchase:${paymentId}`;
    const request = grant(userId, { consent: { analytics: true, ads: true }, click: recentClick(), transactionId });

    await grantPayment(paymentId, request);
    await grantPayment(paymentId, request);

    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "credit_purchase_completed",
        user_id: userId,
        insert_id: transactionId,
        event_properties: { credits: 1700, amount_cents: 2000, currency: "usd" },
      }),
    ]);
    await expect.poll(() => getUploadStatus({ conversion: "credit_purchase", transactionId })).toBe("queued");
    // The upload keeps no link to the order, so the order's row is never held by it.
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'ads_conversion_uploads'
    `;
    expect(columns.map((c) => c.column_name)).not.toContain("payment_id");
  });

  it("reports nothing for an order placed without consent", async () => {
    const userId = await account();
    const paymentId = randomUUID();
    const transactionId = `purchase:${paymentId}`;

    await grantPayment(paymentId, grant(userId, { consent: { analytics: false, ads: false }, click: recentClick(), transactionId }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sent).toEqual([]);
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId })).toBeNull();
  });
});

describe("credit purchases whose consent was erased", () => {
  it("replays the stored grant for a retry whose conversion changed, granting and reporting nothing more", async () => {
    const userId = await account();
    const paymentId = randomUUID();
    const transactionId = `purchase:${paymentId}`;

    const request = grant(userId, { consent: { analytics: true, ads: true }, click: recentClick(), transactionId });

    const first = await grantPayment(paymentId, request);
    // The account was erased before the retry: the billing service dropped the order's consent and click.
    const again = await grantPayment(paymentId, { ...request, conversion: { consent: { analytics: false, ads: false }, click: null, transactionId } });

    expect(first.httpStatus).toBe(200);
    expect(again).toEqual(first);
    expect(await sql`SELECT count(*)::int AS n FROM credit_lots WHERE source_id = ${paymentId}`).toEqual([{ n: 1 }]);
    expect(sent.filter((e) => e.event_type === "credit_purchase_completed")).toHaveLength(1);
  });

  it("grants a first delivery that arrives with the consent erased and queues no conversion", async () => {
    const userId = await account();
    const paymentId = randomUUID();
    const transactionId = `purchase:${paymentId}`;

    const answer = await grantPayment(paymentId, grant(userId, { consent: { analytics: false, ads: false }, click: null, transactionId }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(answer.httpStatus).toBe(200);
    expect(await sql`SELECT count(*)::int AS n FROM credit_lots WHERE source_id = ${paymentId}`).toEqual([{ n: 1 }]);
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId })).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("subscriptions", () => {
  it("reports the start once, under the consent the billing service sent, and queues its conversion", async () => {
    const userId = await account();
    const sub = `sub_${randomUUID()}`;
    const transactionId = `sub:${sub}`;
    const request: SubscriptionFactRequest = {
      userId,
      fact: {
        stripeSubscriptionId: sub,
        tier: "pro",
        period: "month",
        status: "active",
        currentPeriodEnd: "2099-01-01T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        hasPendingUpdate: false,
        pendingTier: null,
        pendingPeriod: null,
        observedAt: new Date().toISOString(),
        firstActiveAt: new Date().toISOString(),
      },
      notices: [],
      started: {
        properties: { tier: "pro", interval: "month", amountCents: 1599, currency: "usd" },
        consent: { analytics: true, ads: true },
        click: recentClick(),
        transactionId,
      },
      referenceId: "evt_started",
    };
    const delivery = randomUUID();

    await applySubscriptionFact(delivery, request);
    await applySubscriptionFact(delivery, request);

    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "subscription_started",
        user_id: userId,
        insert_id: transactionId,
        event_properties: { tier: "pro", interval: "month", amount_cents: 1599, currency: "usd" },
      }),
    ]);
    await expect.poll(() => getUploadStatus({ conversion: "subscription", transactionId })).toBe("queued");
  });
});
