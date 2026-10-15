// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Purchase and subscription events (inner#1442 design §4.8, §4.9) — real PG
 * and Redis, doubled Stripe client.
 *
 * A purchase or subscription finishes in a webhook or a later visit with no
 * cookie of the buying browser, so each follows the consent the order or the
 * subscription carried from checkout; a renewal has no browser behind it and
 * follows the account's latest choice.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, inject, vi } from "vitest";

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

const stripe = {
  checkout: { sessions: { retrieve: vi.fn(), expire: vi.fn() } },
  subscriptions: { retrieve: vi.fn() },
};
vi.mock("@server/infra/stripe.js", () => ({ getStripeClient: () => stripe }));
vi.mock("@server/modules/payment/purchase-mail.js", () => ({ sendPurchaseConfirmation: vi.fn() }));
vi.mock("@server/utils/send-best-effort-mail.js", () => ({ sendBestEffortMail: vi.fn() }));

import type Stripe from "stripe";
import postgres from "postgres";
import {
  ADS_CONVERSION_QUEUE,
  createQueue,
  getSubscriptionPlan,
  getUploadStatus,
  initCore,
  initServerAnalytics,
  loadLocales,
  resetServerAnalyticsForTest,
  setAdsConversionConfigForTest,
  type OutgoingEvent,
} from "@breatic/core";
import { CONSENT_REVISION, type BrowserAdsSnapshot } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const { fulfillPayment, handlePaymentFailed, paidOrder } = await import("@server/modules/payment/payment.service.js");
const { handleSubscriptionEvent } = await import("@server/modules/subscription/subscription-events.js");

let sql: ReturnType<typeof postgres>;
let seq = 0;
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
  vi.clearAllMocks();
  sent.splice(0);
});

afterAll(async () => {
  resetServerAnalyticsForTest();
  setAdsConversionConfigForTest(undefined);
  await createQueue(ADS_CONVERSION_QUEUE).obliterate({ force: true });
  await sql?.end({ timeout: 1 });
});

/**
 * An account with a Stripe customer.
 * @returns Its id and customer id.
 */
async function account(): Promise<{ userId: string; customerId: string }> {
  seq += 1;
  const stamp = `${Date.now()}-${seq}`;
  const customerId = `cus_billing_${stamp}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, stripe_customer_id)
    VALUES (${`billing-${stamp}@example.test`}, true, ${customerId}) RETURNING id
  `;
  return { userId: row!.id, customerId };
}

/**
 * A pending credit order carrying the given checkout metadata.
 * @param metadata - What `createCheckout` would have stored.
 * @returns The order's ids.
 */
async function pendingOrder(metadata: Record<string, unknown>): Promise<{ userId: string; paymentId: string; sessionId: string }> {
  const { userId } = await account();
  const sessionId = `cs_billing_${Date.now()}_${seq}`;
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
  `;
  await sql`
    INSERT INTO payments (id, user_id, stripe_session_id, amount_cents, credits_granted, currency, status, metadata)
    VALUES (${source!.id}, ${userId}, ${sessionId}, 2000, 1700, 'usd', 'pending',
            ${sql.json({ locale: "en", consentedAt: new Date().toISOString(), ...metadata })})
  `;
  stripe.checkout.sessions.retrieve.mockResolvedValue({
    id: sessionId,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_subtotal: 2000,
    amount_total: 2240,
    currency: "usd",
    total_details: { amount_tax: 240 },
    payment_intent: `pi_${sessionId}`,
    metadata: {},
  });
  return { userId, paymentId: source!.id, sessionId };
}

/**
 * The ads side of a browser that accepted ads, as a request or order snapshot holds it.
 * @returns The snapshot.
 */
function adsAccepted(): BrowserAdsSnapshot {
  return { consent: true };
}

describe("credit purchases", () => {
  it("reports the grant once, under the order's consent, and queues its conversion", async () => {
    const { userId, paymentId, sessionId } = await pendingOrder({
      analyticsConsent: { analytics: true, ads: true },
      adsBrowser: adsAccepted(),
      adClick: recentClick(),
    });

    await fulfillPayment(sessionId, { id: `evt_${sessionId}`, type: "checkout.session.completed" });
    await fulfillPayment(sessionId, null);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "credit_purchase_completed",
        user_id: userId,
        insert_id: `purchase:${sessionId}`,
        event_properties: { credits: 1700, amount_cents: 2000, currency: "usd" },
      }),
    ]);
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: `purchase:${sessionId}` })).toBe("queued");
    const [row] = await sql<{ payment_id: string }[]>`
      SELECT payment_id FROM ads_conversion_uploads WHERE transaction_id = ${`purchase:${sessionId}`}
    `;
    expect(row!.payment_id).toBe(paymentId);
    expect(await paidOrder(sessionId)).toEqual({ paid: true, amountCents: 2000, currency: "usd" });
  });

  it("reports nothing for an order placed without consent", async () => {
    const { sessionId } = await pendingOrder({});
    await fulfillPayment(sessionId, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);
    expect(await getUploadStatus({ conversion: "credit_purchase", transactionId: `purchase:${sessionId}` })).toBeNull();
  });

  it("reports a delayed payment that failed", async () => {
    const { paymentId, sessionId } = await pendingOrder({ analyticsConsent: { analytics: true, ads: false } });
    await handlePaymentFailed(sessionId);
    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "credit_purchase_failed",
        insert_id: `purchase-failed:${paymentId}`,
        event_properties: { success: false, error_code: "async_payment_failed" },
      }),
    ]);
    expect((await paidOrder(sessionId)).paid).toBe(false);
  });
});

describe("subscriptions", () => {
  const plan = getSubscriptionPlan("pro", "month");
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

  /**
   * A subscription as Stripe describes it.
   * @param customerId - Its customer.
   * @param status - Its status.
   * @returns The object.
   */
  function stripeSub(customerId: string, status: string): Stripe.Subscription {
    return {
      id: `sub_billing_${customerId}`,
      customer: customerId,
      status,
      cancel_at_period_end: false,
      pending_update: null,
      latest_invoice: null,
      metadata: {
        analyticsConsent: JSON.stringify({ analytics: true, ads: true }),
        adsBrowser: JSON.stringify(adsAccepted()),
        adClick: JSON.stringify(recentClick()),
      },
      items: {
        data: [
          {
            id: "si_1",
            current_period_end: periodEnd,
            price: { id: plan.stripePriceId, unit_amount: plan.priceCents, currency: plan.currency, recurring: { interval: "month" } },
          },
        ],
      },
    } as unknown as Stripe.Subscription;
  }

  /**
   * A webhook event.
   * @param type - Its type.
   * @param object - Its data object.
   * @returns The event.
   */
  function event(type: string, object: unknown): Stripe.Event {
    seq += 1;
    if (type.startsWith("customer.subscription.")) stripe.subscriptions.retrieve.mockResolvedValue(object);
    return { id: `evt_billing_${Date.now()}_${seq}`, type, data: { object } } as unknown as Stripe.Event;
  }

  it("reports the first activation once, under the subscription's consent", async () => {
    const { userId, customerId } = await account();
    await handleSubscriptionEvent(event("customer.subscription.created", stripeSub(customerId, "incomplete")));
    expect(sent).toEqual([]);

    await handleSubscriptionEvent(event("customer.subscription.updated", stripeSub(customerId, "active")));
    await handleSubscriptionEvent(event("customer.subscription.updated", stripeSub(customerId, "active")));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const txn = `sub:sub_billing_${customerId}`;
    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "subscription_started",
        user_id: userId,
        insert_id: txn,
        event_properties: { tier: "pro", interval: "month", amount_cents: plan.priceCents, currency: plan.currency },
      }),
    ]);
    expect(await getUploadStatus({ conversion: "subscription", transactionId: txn })).toBe("queued");
  });

  it("reports a renewal under the latest reported consent, and nothing without one", async () => {
    const { userId, customerId } = await account();
    await handleSubscriptionEvent(event("customer.subscription.created", stripeSub(customerId, "active")));
    sent.splice(0);
    const renewal = { id: `in_${customerId}`, customer: customerId, billing_reason: "subscription_cycle" };

    await handleSubscriptionEvent(event("invoice.paid", renewal));
    expect(sent).toEqual([]);

    await sql`UPDATE users SET consent_seen = ${sql.json({
      analytics: { value: true, revision: CONSENT_REVISION },
      ads: { value: false, revision: CONSENT_REVISION },
      reportedAt: new Date().toISOString(),
    })} WHERE id = ${userId}`;
    const paid = event("invoice.paid", renewal);
    await handleSubscriptionEvent(paid);
    expect(sent).toEqual([
      expect.objectContaining({ event_type: "subscription_renewed", user_id: userId, insert_id: paid.id }),
    ]);
  });

  it("hands the return page the conversion once the subscription is active", async () => {
    const { subscriptionConversion } = await import("@server/modules/subscription/subscription-analytics.js");
    const write = { stripeSubscriptionId: "sub_x", status: "active", tier: "pro", period: "month" } as const;
    expect(subscriptionConversion(write)).toEqual({
      transactionId: "sub:sub_x",
      amountCents: plan.priceCents,
      currency: plan.currency,
    });
    expect(subscriptionConversion({ ...write, status: "incomplete" })).toBeNull();
  });

  it("ignores a paid invoice that is not a renewal", async () => {
    const { customerId } = await account();
    const outcome = await handleSubscriptionEvent(
      event("invoice.paid", { id: "in_first", customer: customerId, billing_reason: "subscription_create" }),
    );
    expect(outcome.status).toBe("acknowledged");
    expect(sent).toEqual([]);
  });
});
