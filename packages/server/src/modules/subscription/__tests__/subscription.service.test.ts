// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 订阅的四条用户动作（#106 §7、§6.5.3）。
 *
 * 这里只测「分流对不对、拒绝对不对」—— Stripe 客户端整个被替身顶掉，断言的是
 * 我们发给它的参数，因为出错的那几处恰恰都在参数上：
 *
 * - 换档不带 `items[0].id` 就是**加一个价格**而不是换掉，账号从此持有两份会员；
 * - 不用 `pending_if_incomplete`，默认行为是「先改订阅再收钱，收不到也已经改了」；
 * - 已预约取消的账号直接换 price，付了钱期末照样掉档，因为那个标记没被清掉。
 *
 * 认人链路也在这里：结账前必须先有 customer，因为订阅事件上不带任何我们的标识。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const stripe = {
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  subscriptions: { update: vi.fn(), retrieve: vi.fn() },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

vi.mock("@breatic/core", () => ({
  listSubscriptions: vi.fn(),
  upsertSubscription: vi.fn(),
  subscriptionSituation: vi.fn(),
  getSubscriptionPlan: (tier: string) => ({
    priceCents: tier === "pro" ? 1200 : 3900,
    currency: "usd",
    stripePriceId: tier === "pro" ? "price_pro" : "price_team",
  }),
  findSubscribableTierByPriceId: (priceId: string) =>
    ({ price_pro: "pro", price_team: "team" })[priceId] ?? null,
  ConflictError: class ConflictError extends Error {},
  ValidationError: class ValidationError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
  t: (key: string) => key,
  env: { PAYMENT_ENABLED: true },
}));

vi.mock("@server/modules/auth/user.repo.js", () => ({
  getUserById: vi.fn(),
  getStripeCustomerId: vi.fn(),
  setStripeCustomerId: vi.fn(),
  findUserIdByStripeCustomerId: vi.fn(),
}));

import {
  listSubscriptions,
  subscriptionSituation,
  ConflictError,
  ValidationError,
} from "@breatic/core";
import * as userRepo from "@server/modules/auth/user.repo.js";
import * as service from "@server/modules/subscription/subscription.service.js";

const USER = "u-1";
const RETURN_URL = "https://app.example/studio/me";

/**
 * Points the situation reading at one answer.
 * @param situation - What the account's situation is.
 * @param record - The live row, when there is one.
 */
function situationIs(situation: string, record: unknown = null): void {
  vi.mocked(listSubscriptions).mockResolvedValue([]);
  vi.mocked(subscriptionSituation).mockReturnValue({
    situation,
    record,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(userRepo.getStripeCustomerId).mockResolvedValue("cus_1");
  vi.mocked(userRepo.getUserById).mockResolvedValue({
    id: USER,
    email: "a@example.test",
  } as never);
  stripe.checkout.sessions.create.mockResolvedValue({
    url: "https://checkout.example/s",
  });
});

describe("startCheckout — no live subscription (#106 §7.2)", () => {
  it("creates the customer first when the account has never paid us", async () => {
    // Subscription events carry no identifier of ours, so the customer has to
    // exist and be stored BEFORE checkout. Letting Stripe make one during
    // checkout means first meeting that id inside an event with nothing to
    // match it against.
    vi.mocked(userRepo.getStripeCustomerId).mockResolvedValue(null);
    stripe.customers.create.mockResolvedValue({ id: "cus_new" });
    situationIs("none");

    await service.startCheckout({
      userId: USER,
      tier: "pro",
      returnUrl: RETURN_URL,
    });

    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { userId: USER } }),
      { idempotencyKey: `customer:${USER}` },
    );
    expect(userRepo.setStripeCustomerId).toHaveBeenCalledWith(USER, "cus_new");
  });

  it("reuses the stored customer rather than making a second one", async () => {
    situationIs("none");
    await service.startCheckout({
      userId: USER,
      tier: "pro",
      returnUrl: RETURN_URL,
    });
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("puts the account id on the subscription, not only on the session", async () => {
    // Top-level metadata reaches the Session object and stops there. The
    // second identification line has to be attached to the subscription.
    situationIs("none");
    await service.startCheckout({
      userId: USER,
      tier: "team",
      returnUrl: RETURN_URL,
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_1",
        line_items: [{ price: "price_team", quantity: 1 }],
        subscription_data: { metadata: { userId: USER } },
      }),
    );
  });

  it("starts a fresh subscription for an account whose last one ended", async () => {
    // Acceptance item 7. An ended subscription cannot be updated or revived,
    // so this must not take the upgrade path.
    situationIs("none");
    await service.startCheckout({
      userId: USER,
      tier: "pro",
      returnUrl: RETURN_URL,
    });
    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("refuses to sell a second subscription to an account that has one", async () => {
    situationIs("active", { tier: "pro", stripeSubscriptionId: "sub_1" });
    await expect(
      service.startCheckout({
        userId: USER,
        tier: "team",
        returnUrl: RETURN_URL,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("changePlan — an account that already subscribes (#106 §7.3)", () => {
  /**
   * The live row for an account on PRO.
   * @param over - Fields this case changes.
   * @returns A stored subscription.
   */
  function proRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      stripeSubscriptionId: "sub_1",
      stripeItemId: "si_1",
      tier: "pro",
      cancelAtPeriodEnd: false,
      ...over,
    };
  }

  beforeEach(() => {
    stripe.subscriptions.update.mockResolvedValue({
      id: "sub_1",
      status: "active",
      pending_update: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      items: {
        data: [
          { id: "si_1", current_period_end: 1_789_000_000, price: { id: "price_team" } },
        ],
      },
    });
  });

  it("replaces the price on the existing item instead of adding one", async () => {
    // Omitting `items[0].id` ADDS a price. The account would then hold two
    // memberships and be billed for both.
    situationIs("active", proRow());

    await service.changePlan({ userId: USER, tier: "team" });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({
        items: [{ id: "si_1", price: "price_team" }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      }),
    );
  });

  it("clears a scheduled cancellation before switching plans", async () => {
    // Otherwise the upgrade is paid for and the plan still ends at the period
    // boundary, because nothing removed the flag.
    situationIs("cancelling", proRow({ cancelAtPeriodEnd: true }));

    await service.changePlan({ userId: USER, tier: "team" });

    expect(stripe.subscriptions.update).toHaveBeenNthCalledWith(1, "sub_1", {
      cancel_at_period_end: false,
    });
    expect(stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      "sub_1",
      expect.objectContaining({ items: [{ id: "si_1", price: "price_team" }] }),
    );
  });

  it("refuses a move to a lower tier", async () => {
    // No entrance offers this; anything reaching it called the endpoint
    // directly.
    situationIs("active", proRow({ tier: "team" }));
    await expect(
      service.changePlan({ userId: USER, tier: "pro" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a move to the tier already held", async () => {
    situationIs("active", proRow());
    await expect(
      service.changePlan({ userId: USER, tier: "pro" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to upgrade an account that is behind on payment", async () => {
    // Ratified: the paid tier holds while Stripe retries, but selling more
    // during that window would bill somebody whose card is already failing.
    situationIs("retrying", proRow());
    await expect(
      service.changePlan({ userId: USER, tier: "team" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("hands back the payment link when the difference was not charged", async () => {
    situationIs("active", proRow());
    stripe.subscriptions.update.mockResolvedValueOnce({
      id: "sub_1",
      status: "active",
      cancel_at_period_end: false,
      pending_update: {
        expires_at: 0,
        subscription_items: [{ id: "si_1", price: { id: "price_team" } }],
      },
      latest_invoice: {
        status: "open",
        hosted_invoice_url: "https://invoice.example/pay",
      },
      items: {
        data: [
          { id: "si_1", current_period_end: 1_789_000_000, price: { id: "price_pro" } },
        ],
      },
    });

    const result = await service.changePlan({ userId: USER, tier: "team" });

    expect(result.payableInvoiceUrl).toBe("https://invoice.example/pay");
  });
});

describe("cancel and resume (#106 §7.5)", () => {
  beforeEach(() => {
    stripe.subscriptions.update.mockResolvedValue({
      id: "sub_1",
      status: "active",
      cancel_at_period_end: true,
      pending_update: null,
      latest_invoice: null,
      items: {
        data: [
          { id: "si_1", current_period_end: 1_789_000_000, price: { id: "price_pro" } },
        ],
      },
    });
  });

  it("ends the plan at the period boundary rather than immediately", async () => {
    // The ratified rule is that paid time is used up and nothing is refunded.
    situationIs("active", { stripeSubscriptionId: "sub_1", tier: "pro" });

    await service.cancel(USER);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      cancel_at_period_end: true,
    });
  });

  it("refuses to cancel when there is nothing live", async () => {
    situationIs("none");
    await expect(service.cancel(USER)).rejects.toBeInstanceOf(ConflictError);
  });

  it("takes back a scheduled cancellation", async () => {
    situationIs("cancelling", {
      stripeSubscriptionId: "sub_1",
      tier: "pro",
      cancelAtPeriodEnd: true,
    });

    await service.resume(USER);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      cancel_at_period_end: false,
    });
  });

  it("refuses to resume a plan that is not ending", async () => {
    situationIs("active", { stripeSubscriptionId: "sub_1", tier: "pro" });
    await expect(service.resume(USER)).rejects.toBeInstanceOf(ConflictError);
  });
});
