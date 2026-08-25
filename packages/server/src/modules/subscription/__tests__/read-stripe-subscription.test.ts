// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 把 Stripe 的订阅对象读成我们要存的那一行（#106 §5.2、§8）。
 *
 * 三个事实是这里的全部难点，每一个错了都不会当场报错：
 *
 * 一、**期末时间不在订阅对象上**。2025-03-31 那一版起，`current_period_end`
 * 搬到了 `items.data[].current_period_end`；读旧位置永远拿到 undefined，于是
 * §10.1 那道「早就过期了」的检查再也判不出来。
 *
 * 二、**档位从 price id 反查**，Stripe 送来的订阅上没有我们的档位名。
 *
 * 三、**「有未付的升级」和「欠着一期钱」都会有一张待付发票**，两者要分得开：
 * 前者档位停在原档，后者档位保持不变、界面给的话也不一样。
 */

import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";

vi.mock("@breatic/core", () => ({
  findSubscribableTierByPriceId: (priceId: string) =>
    ({ price_pro: "pro", price_team: "team" })[priceId] ?? null,
}));

import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";

const PERIOD_END = 1_789_000_000;

/**
 * A Stripe subscription in the shape the SDK hands back.
 * @param over - The fields one case cares about.
 * @returns A subscription object.
 */
function stripeSub(over: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    pending_update: null,
    latest_invoice: null,
    items: {
      data: [
        {
          id: "si_1",
          current_period_end: PERIOD_END,
          price: { id: "price_pro" },
        },
      ],
    },
    ...over,
  } as unknown as Stripe.Subscription;
}

describe("readStripeSubscription (#106 §5.2)", () => {
  it("takes the period end off the item, where Stripe moved it", () => {
    // On the subscription itself the field no longer exists. Reading there
    // gives undefined and the lapsed-subscription check silently never fires.
    const read = readStripeSubscription(stripeSub(), "u-1");
    expect(read?.currentPeriodEnd?.getTime()).toBe(PERIOD_END * 1000);
  });

  it("resolves the tier from the price the item sells", () => {
    expect(readStripeSubscription(stripeSub(), "u-1")?.tier).toBe("pro");
  });

  it("refuses a subscription selling a price we do not recognise", () => {
    // Storing it under a guessed tier would hand out ceilings nobody bought.
    // The caller logs and leaves the row alone.
    const foreign = stripeSub({
      items: { data: [{ id: "si_1", price: { id: "price_unknown" } }] },
    });
    expect(readStripeSubscription(foreign, "u-1")).toBeNull();
  });

  it("carries the status, the item id and the scheduled cancellation", () => {
    const read = readStripeSubscription(
      stripeSub({ status: "past_due", cancel_at_period_end: true }),
      "u-1",
    );
    expect(read?.status).toBe("past_due");
    expect(read?.stripeItemId).toBe("si_1");
    expect(read?.cancelAtPeriodEnd).toBe(true);
  });

  it("reads an unpaid upgrade and which tier it is for", () => {
    const read = readStripeSubscription(
      stripeSub({
        pending_update: {
          expires_at: 0,
          subscription_items: [{ id: "si_1", price: { id: "price_team" } }],
        },
      }),
      "u-1",
    );
    expect(read?.hasPendingUpdate).toBe(true);
    expect(read?.pendingTier).toBe("team");
    // Still the tier that has been paid for. The upgrade's ceilings arrive
    // when its invoice does.
    expect(read?.tier).toBe("pro");
  });

  it("leaves the pending flag off when there is no unpaid upgrade", () => {
    const read = readStripeSubscription(stripeSub(), "u-1");
    expect(read?.hasPendingUpdate).toBe(false);
    expect(read?.pendingTier).toBeNull();
  });

  it("takes the payment link from an invoice that is still open", () => {
    const read = readStripeSubscription(
      stripeSub({
        status: "past_due",
        latest_invoice: {
          status: "open",
          hosted_invoice_url: "https://invoice.example/pay",
        },
      }),
      "u-1",
    );
    expect(read?.payableInvoiceUrl).toBe("https://invoice.example/pay");
  });

  it("gives no payment link when the last invoice is paid", () => {
    // A stale link would put "finish paying" in front of somebody who is up
    // to date.
    const read = readStripeSubscription(
      stripeSub({
        latest_invoice: {
          status: "paid",
          hosted_invoice_url: "https://invoice.example/pay",
        },
      }),
      "u-1",
    );
    expect(read?.payableInvoiceUrl).toBeNull();
  });

  it("gives no payment link when the invoice was not expanded", () => {
    // Unexpanded, `latest_invoice` is just an id string. Treating that as an
    // object would put `undefined` in the column.
    const read = readStripeSubscription(
      stripeSub({ latest_invoice: "in_123" }),
      "u-1",
    );
    expect(read?.payableInvoiceUrl).toBeNull();
  });

  it("survives a subscription with no items at all", () => {
    expect(
      readStripeSubscription(stripeSub({ items: { data: [] } }), "u-1"),
    ).toBeNull();
  });
});
