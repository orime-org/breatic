// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Stripe's `billing_cycle_anchor` as we read it (inner#1968, test spec C-29),
 * against Stripe test mode.
 *
 * Asserted: a new monthly subscription's anchor, read by
 * `readStripeSubscription` into the row we store, is the moment it started.
 * Recorded, not asserted (the spec asks for the observed answer, never a
 * prediction): whether a switch to yearly billing, or an upgrade within the
 * same interval, moves the anchor. Each prints a line starting
 * `@needs-payments observed:` to be copied into this header when the sub-gate
 * is run.
 *
 * Every case is tagged, so the default integration run leaves the file out.
 * Run it on purpose, with the price list configured for the test-mode account:
 *
 *   STRIPE_SECRET_KEY=sk_test_… pnpm exec turbo run test:integration --filter=@breatic/server --env-mode=loose -- \
 *     -t @needs-payments src/__tests__/integration/operation-anchor-real-stripe.integration.test.ts
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { getSubscriptionPlan, initCore } from "@breatic/core";
import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";

let stripe: Stripe;
const customers: string[] = [];

beforeAll(() => {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    throw new Error("This suite runs against Stripe test mode only: set STRIPE_SECRET_KEY to an sk_test_ key.");
  }
  stripe = new Stripe(key);
  initCore({ ...process.env, PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite" });
});

afterAll(async () => {
  for (const id of customers) await stripe.customers.del(id);
  initCore(process.env);
});

/**
 * A subscription paid with `pm_card_visa`, read back with its price expanded.
 * @param priceId - The price to subscribe to.
 * @returns The subscription.
 */
async function subscribe(priceId: string): Promise<Stripe.Subscription> {
  const customer = await stripe.customers.create({ payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" } });
  customers.push(customer.id);
  return stripe.subscriptions.create({ customer: customer.id, items: [{ price: priceId }], expand: ["items.data.price", "latest_invoice"] });
}

/**
 * The anchor our reading stores for a subscription.
 * @param subscription - What Stripe answered.
 * @returns The stored anchor.
 */
function storedAnchor(subscription: Stripe.Subscription): Date | null {
  const read = readStripeSubscription(subscription, randomUUID());
  if (!read.ok) throw new Error(`readStripeSubscription refused: ${read.reason}`);
  return (read.write as typeof read.write & { billingCycleAnchor: Date | null }).billingCycleAnchor;
}

describe("billing_cycle_anchor against Stripe test mode", () => {
  it("C-29 stores a new monthly subscription's anchor as its start, and records what a yearly switch and an upgrade do @needs-payments", async () => {
    const created = await subscribe(getSubscriptionPlan("pro", "month").stripePriceId);
    expect(storedAnchor(created)?.toISOString()).toBe(new Date(created.start_date * 1000).toISOString());
    expect(storedAnchor(created)?.toISOString()).toBe(new Date(created.billing_cycle_anchor * 1000).toISOString());

    const item = created.items.data[0]!;
    const yearly = await stripe.subscriptions.update(created.id, {
      items: [{ id: item.id, price: getSubscriptionPlan("pro", "year").stripePriceId }],
      expand: ["items.data.price", "latest_invoice"],
    });
    console.info(`@needs-payments observed: monthly to yearly: ${JSON.stringify({ before: storedAnchor(created), after: storedAnchor(yearly) })}`);

    const other = await subscribe(getSubscriptionPlan("pro", "month").stripePriceId);
    const upgraded = await stripe.subscriptions.update(other.id, {
      items: [{ id: other.items.data[0]!.id, price: getSubscriptionPlan("team", "month").stripePriceId }],
      expand: ["items.data.price", "latest_invoice"],
    });
    console.info(`@needs-payments observed: pro to team, monthly: ${JSON.stringify({ before: storedAnchor(other), after: storedAnchor(upgraded) })}`);
  });
});
