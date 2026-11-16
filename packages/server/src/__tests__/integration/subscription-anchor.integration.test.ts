// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `subscriptions.billing_cycle_anchor` as every Stripe path stores it
 * (inner#1968, test spec A-27, A-28), against real Postgres.
 *
 * The Stripe object here is our own fixture: these cases pin what we read
 * from it and how the write arbitrates by `observedAt`, not how Stripe
 * answers (that is the `@needs-payments` suite C-29).
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

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

import type Stripe from "stripe";
import postgres from "postgres";
import { db, getSubscriptionPlan, initCore, loadLocales, upsertSubscription } from "@breatic/core";
import { applySubscriptionWrite } from "@server/modules/subscription/apply-subscription.js";
import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  try {
    initCore(process.env);
  } catch {
    // already initialised by a sibling suite in this worker
  }
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "subscription-anchor-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A Stripe subscription object for a monthly PRO price.
 * @param over - Top-level fields to set.
 * @returns The object as the SDK types it.
 */
function stripeSub(over: Record<string, unknown>): Stripe.Subscription {
  const plan = getSubscriptionPlan("pro", "month");
  return {
    id: `sub_anchor_${randomUUID()}`,
    customer: "cus_anchor",
    status: "active",
    cancel_at_period_end: false,
    pending_update: null,
    latest_invoice: null,
    items: {
      data: [{
        id: "si_anchor",
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
        price: { id: plan.stripePriceId, unit_amount: plan.priceCents, currency: plan.currency, recurring: { interval: "month" } },
      }],
    },
    ...over,
  } as unknown as Stripe.Subscription;
}

/**
 * A fresh account.
 * @returns Its id.
 */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into users(email, email_verified) values (${`${randomUUID()}@example.test`}, true) returning id`;
  return row!.id;
}

/**
 * The stored anchor of one subscription.
 * @param stripeId - Its Stripe id.
 * @returns The anchor, or null.
 */
async function storedAnchor(stripeId: string): Promise<Date | null> {
  const [row] = await sql<{ billing_cycle_anchor: Date | null }[]>`select billing_cycle_anchor from subscriptions where stripe_subscription_id = ${stripeId}`;
  return row!.billing_cycle_anchor;
}

describe("billing cycle anchor", () => {
  it("A-27 Stripe's billing_cycle_anchor in Unix seconds is read and stored as that instant", async () => {
    const userId = await user();
    const subscription = stripeSub({ billing_cycle_anchor: 1767225600 });
    const read = readStripeSubscription(subscription, userId);
    if (!read.ok) throw new Error(`fixture unreadable: ${read.reason}`);
    expect(read.write).toMatchObject({ billingCycleAnchor: new Date("2026-01-01T00:00:00.000Z") });
    await db.transaction((tx) => applySubscriptionWrite({ userId, write: read.write, referenceId: `anchor-${randomUUID()}`, tx }));
    expect((await storedAnchor(subscription.id))?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("A-28 an older snapshot does not overwrite the anchor a newer snapshot stored", async () => {
    const userId = await user();
    const subscription = stripeSub({ billing_cycle_anchor: 1767225600 });
    const read = readStripeSubscription(subscription, userId);
    if (!read.ok) throw new Error(`fixture unreadable: ${read.reason}`);
    const t2 = new Date();
    const t1 = new Date(t2.getTime() - 60_000);
    const a2 = new Date("2026-02-01T00:00:00.000Z");
    const a1 = new Date("2026-01-01T00:00:00.000Z");
    await upsertSubscription({ ...read.write, billingCycleAnchor: a2, observedAt: t2 });
    expect((await storedAnchor(subscription.id))?.toISOString()).toBe(a2.toISOString());
    await upsertSubscription({ ...read.write, billingCycleAnchor: a1, observedAt: t1 });
    expect((await storedAnchor(subscription.id))?.toISOString()).toBe(a2.toISOString());
  });
});
