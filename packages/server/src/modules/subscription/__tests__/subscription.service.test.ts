// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
  subscriptions: { update: vi.fn(), retrieve: vi.fn(), cancel: vi.fn() },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

vi.mock("@breatic/core", () => ({
  listSubscriptions: vi.fn(),
  upsertSubscription: vi.fn(),
  subscriptionSituation: vi.fn(),
  subscriptionClock: () => ({ now: new Date(), staleAfterMs: 0 }),
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
  // Keyed by both halves, because a price now sells a tier AND a period.
  getSubscriptionPlan: (tier: string, period: string) => ({
    priceCents: (tier === "pro" ? 1999 : 7999) * (period === "year" ? 10 : 1),
    currency: "usd",
    stripePriceId: `price_${tier}_${period}`,
  }),
  findOfferByPriceId: (priceId: string) => {
    const [, tier, period] = priceId.split("_");
    return tier && period ? { tier, period } : null;
  },
  AppError: class AppError extends Error {
    public readonly statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  ConflictError: class ConflictError extends Error {},
  ValidationError: class ValidationError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
  t: (key: string) => key,
  env: { PAYMENT_ENABLED: true },
  getStripeCallTimeoutMs: () => 5000,
  LIVE_SUBSCRIPTION_STATUSES: ["incomplete", "active", "past_due"],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { applySubscriptionWrite, sendMembershipEndedMail } = vi.hoisted(() => ({
  applySubscriptionWrite: vi.fn(),
  sendMembershipEndedMail: vi.fn(),
}));

vi.mock("@server/modules/subscription/apply-subscription.js", () => ({
  applySubscriptionWrite,
}));

vi.mock("@server/modules/subscription/settle-tier.js", () => ({
  sendMembershipEndedMail,
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
    lapsed: null,
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
      period: "month",
      returnUrl: RETURN_URL,
    });

    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { userId: USER } }),
      { idempotencyKey: `customer:${USER}` },
    );
    expect(userRepo.setStripeCustomerId).toHaveBeenCalledWith(USER, "cus_new");
  });

  it("marks the two ways back apart, so the page can say what happened", async () => {
    // Both URLs land on the page they left. Without a mark on them it cannot
    // tell a completed payment from somebody pressing Stripe's back link, and
    // so cannot report either.
    situationIs("none");
    await service.startCheckout({
      userId: USER,
      tier: "pro",
      period: "year",
      returnUrl: RETURN_URL,
    });

    const call = stripe.checkout.sessions.create.mock.calls[0]?.[0];
    expect(call.success_url).toContain("membership=1");
    expect(call.success_url).not.toContain("cancelled");
    expect(call.cancel_url).toContain("membership=1");
    expect(call.cancel_url).toContain("cancelled=1");
  });

  it("names the checkout on the way back, so the return can confirm it (#307 A5)", async () => {
    // Stripe fills `{CHECKOUT_SESSION_ID}` in on its way out, so the braces
    // must reach it untouched; URL-encoding them leaves the literal text in
    // the address and the return has nothing to confirm.
    situationIs("none");
    await service.startCheckout({
      userId: USER,
      tier: "pro",
      period: "month",
      returnUrl: RETURN_URL,
    });

    const call = stripe.checkout.sessions.create.mock.calls[0]?.[0];
    expect(call.success_url).toMatch(/[?&]session_id=\{CHECKOUT_SESSION_ID\}$/);
    expect(call.cancel_url).not.toContain("session_id");
  });

  it("reuses the stored customer rather than making a second one", async () => {
    situationIs("none");
    await service.startCheckout({
      userId: USER,
      tier: "pro",
      period: "month",
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
      period: "month",
      returnUrl: RETURN_URL,
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer: "cus_1",
        line_items: [{ price: "price_team_month", quantity: 1 }],
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
      period: "month",
      returnUrl: RETURN_URL,
    });
    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("先作废那张没付成的订阅，再开新的结账", async () => {
    // Stripe 不让更新首期未付成的订阅，所以这类账号只能重开结账 —— 但旧的
    // 那张还挂在那儿，付款页也还能打开。不作废它，两张都付掉就是两份会员，
    // 而挑哪一份生效由「取最新一行」这个任意判据决定。
    situationIs("firstPaymentUnsettled", {
      stripeSubscriptionId: "sub_unpaid",
      tier: "pro",
      period: "month",
    });
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_unpaid",
      status: "incomplete",
    });
    stripe.subscriptions.cancel.mockResolvedValue({});

    await service.startCheckout({
      userId: USER,
      tier: "pro",
      period: "month",
      returnUrl: RETURN_URL,
    });

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_unpaid");
    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
  });

  it("那张订阅其实已经付掉了，就不作废它，也不再卖一次", async () => {
    // 面板对首付未成的账号同时给两样东西：一条在新标签页打开的付款链接，
    // 和照常可点的档位按钮。用户在新标签页把钱付了，回到原标签页（那一页
    // 按策略不会自己重拉）再点一次，存下来的行还是 incomplete —— 照着它
    // 取消，取消掉的是一张刚付过 12 美元的订阅，而 Stripe 的取消不退款。
    situationIs("firstPaymentUnsettled", {
      stripeSubscriptionId: "sub_paid_meanwhile",
      tier: "pro",
      period: "month",
    });
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_paid_meanwhile",
      status: "active",
    });

    await expect(
      service.startCheckout({
        userId: USER,
        tier: "pro",
        period: "month",
        returnUrl: RETURN_URL,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("Stripe 说它还是没付成，才作废", async () => {
    situationIs("firstPaymentUnsettled", {
      stripeSubscriptionId: "sub_still_unpaid",
      tier: "pro",
      period: "month",
    });
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_still_unpaid",
      status: "incomplete",
    });
    stripe.subscriptions.cancel.mockResolvedValue({});

    await service.startCheckout({
      userId: USER,
      tier: "pro",
      period: "month",
      returnUrl: RETURN_URL,
    });

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_still_unpaid");
    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
  });

  it.each(["canceled", "incomplete_expired", "unpaid"] as const)(
    "那张订阅在 Stripe 那边已经是 %s，照常开新结账",
    async (status) => {
      // 实测：对一条已终结的订阅调 retrieve，Stripe 返回 200 加那个终结状态，
      // 不是 resource_missing —— 后者只从 cancel、或者对一个压根不存在的 id
      // 才出得来。所以「不是 incomplete 就说他已经有会员了」这个判据，会对
      // 一个名下一份会员都没有的人说「你已经订了」，让他再也订不上。
      situationIs("firstPaymentUnsettled", {
        stripeSubscriptionId: "sub_dead",
        tier: "pro",
        period: "month",
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce({
        id: "sub_dead",
        status,
      });

      await service.startCheckout({
        userId: USER,
        tier: "pro",
        period: "month",
        returnUrl: RETURN_URL,
      });

      expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
      expect(stripe.checkout.sessions.create).toHaveBeenCalled();
    },
  );

  it("那个订阅 id 在 Stripe 那边根本不存在，也照常开新结账", async () => {
    situationIs("firstPaymentUnsettled", {
      stripeSubscriptionId: "sub_gone",
      tier: "pro",
      period: "month",
    });
    stripe.subscriptions.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("No such subscription: sub_gone"), {
        code: "resource_missing",
      }),
    );

    await service.startCheckout({
      userId: USER,
      tier: "pro",
      period: "month",
      returnUrl: RETURN_URL,
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
  });

  it("查到之后、取消之前那张订阅刚好过期，也不算失败", async () => {
    // retrieve 和 cancel 之间隔着一次网络往返，而 incomplete 订阅 24 小时
    // 就到期。正好卡在这中间的话，cancel 会吐 resource_missing —— 它要作废
    // 的东西已经没了，目的达到了，不该把这次结账搞失败。
    situationIs("firstPaymentUnsettled", {
      stripeSubscriptionId: "sub_expiring",
      tier: "pro",
      period: "month",
    });
    stripe.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_expiring",
      status: "incomplete",
    });
    stripe.subscriptions.cancel.mockRejectedValueOnce(
      Object.assign(new Error("No such subscription: sub_expiring"), {
        code: "resource_missing",
      }),
    );

    await service.startCheckout({
      userId: USER,
      tier: "pro",
      period: "month",
      returnUrl: RETURN_URL,
    });

    expect(stripe.checkout.sessions.create).toHaveBeenCalled();
  });

  it("作废失败原因不是「已经没了」就不开结账", async () => {
    // Stripe 连不上、超时、权限不对 —— 这些都没有证明那张未付成的订阅已经
    // 不在了。照样开新结账 = 两张都能付，而哪一份算数只剩「取最新一行」这个
    // 跟用户买了什么无关的判据。
    situationIs("firstPaymentUnsettled", {
      stripeSubscriptionId: "sub_unpaid",
      tier: "pro",
      period: "month",
    });
    stripe.subscriptions.retrieve.mockRejectedValueOnce(
      Object.assign(new Error("Connection error"), { code: "api_connection_error" }),
    );

    await expect(
      service.startCheckout({
        userId: USER,
        tier: "pro",
        period: "month",
        returnUrl: RETURN_URL,
      }),
    ).rejects.toThrow("Connection error");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("refuses to sell a second subscription to an account that has one", async () => {
    situationIs("active", { tier: "pro", stripeSubscriptionId: "sub_1" });
    await expect(
      service.startCheckout({
        userId: USER,
        tier: "team",
        period: "month",
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
      period: "month",
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
          { id: "si_1", current_period_end: 1_789_000_000, price: { id: "price_team_month", unit_amount: 7999, currency: "usd", recurring: { interval: "month" } } },
        ],
      },
    });
  });

  it("replaces the price on the existing item instead of adding one", async () => {
    // Omitting `items[0].id` ADDS a price. The account would then hold two
    // memberships and be billed for both.
    situationIs("active", proRow());

    await service.changePlan({ userId: USER, tier: "team", period: "month" });

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({
        items: [{ id: "si_1", price: "price_team_month" }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      }),
    );
  });

  it("换档那次调用不许带 cancel_at_period_end", async () => {
    // Stripe 不接受这个组合：pending_if_incomplete 只认一张白名单，
    // cancel_at_period_end 不在上面，整个请求当场 400。带上它 = 所有升级
    // 100% 失败，而不是「多传一个没用的字段」。
    situationIs("cancelling", proRow({ cancelAtPeriodEnd: true }));

    await service.changePlan({ userId: USER, tier: "team", period: "month" });

    const [, params] = stripe.subscriptions.update.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params).not.toHaveProperty("cancel_at_period_end");
    expect(params.payment_behavior).toBe("pending_if_incomplete");
  });

  it("升级生效之后才清掉取消预约", async () => {
    // 顺序是「先换档、后清取消预约」，不是反过来。反过来的话第二次失败
    // 会把用户预约的取消永久吃掉：他以为月底停，实际继续扣钱，而且没有
    // 任何东西告诉他。这个顺序下第二次失败只留下「档位升了、月底仍会停」，
    // 面板照常显示结束日期和「恢复」按钮，用户看得见也点得动。
    situationIs("cancelling", proRow({ cancelAtPeriodEnd: true }));

    await service.changePlan({ userId: USER, tier: "team", period: "month" });

    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update).toHaveBeenLastCalledWith("sub_1", {
      cancel_at_period_end: false,
    });
  });

  it("升级还没付成，也照样清掉取消预约", async () => {
    // 点升级这个动作本身就是「我不取消了」—— 面板在这一格给的是升级入口，
    // 用户按下去表达的意思只有这一个。不清的话，他把差价付掉、升级生效之后
    // 取消预约还挂着，期末照样掉档，而促成掉档的正是他为了留下来付的那笔钱。
    situationIs("cancelling", proRow({ cancelAtPeriodEnd: true }));
    stripe.subscriptions.update.mockResolvedValueOnce({
      id: "sub_1",
      status: "active",
      cancel_at_period_end: true,
      pending_update: {
        expires_at: 0,
        subscription_items: [{ id: "si_1", price: { id: "price_team_month", unit_amount: 7999, currency: "usd", recurring: { interval: "month" } } }],
      },
      latest_invoice: {
        status: "open",
        hosted_invoice_url: "https://invoice.example/pay",
      },
      items: {
        data: [
          { id: "si_1", current_period_end: 1_789_000_000, price: { id: "price_pro_month", unit_amount: 1999, currency: "usd", recurring: { interval: "month" } } },
        ],
      },
    });

    await service.changePlan({ userId: USER, tier: "team", period: "month" });

    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update).toHaveBeenLastCalledWith("sub_1", {
      cancel_at_period_end: false,
    });
  });

  it("账号没预约取消时只调一次", async () => {
    situationIs("active", proRow());
    await service.changePlan({ userId: USER, tier: "team", period: "month" });
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  it("存下来的行没有 item id 时，宁可报错也不发那次调用", async () => {
    // Stripe 把没有 id 的 item 当成「新增一个价格」：订阅上挂两档、每月按
    // 12 + 39 收，而我们只记下其中一档。那正是验收第 9 条禁止的后果，所以
    // 这一格不能用「没有就不传」糊过去。
    situationIs("active", proRow({ stripeItemId: null }));

    await expect(
      service.changePlan({ userId: USER, tier: "team", period: "month" }),
    ).rejects.toThrow(/no stored item id/i);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("refuses a move to a lower tier", async () => {
    // No entrance offers this; anything reaching it called the endpoint
    // directly.
    situationIs("active", proRow({ tier: "team" }));
    await expect(
      service.changePlan({ userId: USER, tier: "pro", period: "month" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a move to the tier already held", async () => {
    situationIs("active", proRow());
    await expect(
      service.changePlan({ userId: USER, tier: "pro", period: "month" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to upgrade an account that is behind on payment", async () => {
    // Ratified: the paid tier holds while Stripe retries, but selling more
    // during that window would bill somebody whose card is already failing.
    situationIs("retrying", proRow());
    await expect(
      service.changePlan({ userId: USER, tier: "team", period: "month" }),
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
        subscription_items: [{ id: "si_1", price: { id: "price_team_month", unit_amount: 7999, currency: "usd", recurring: { interval: "month" } } }],
      },
      latest_invoice: {
        status: "open",
        hosted_invoice_url: "https://invoice.example/pay",
      },
      items: {
        data: [
          { id: "si_1", current_period_end: 1_789_000_000, price: { id: "price_pro_month", unit_amount: 1999, currency: "usd", recurring: { interval: "month" } } },
        ],
      },
    });

    const result = await service.changePlan({ userId: USER, tier: "team", period: "month" });

    expect(result.payableInvoiceUrl).toBe("https://invoice.example/pay");
  });
});

describe("the period reaches Stripe on both paths (#253 A7, A8)", () => {
  /**
   * The live row for an account holding one offer.
   * @param tier - The tier it holds.
   * @param period - The period it is billed over.
   * @returns A stored subscription.
   */
  function holding(tier: string, period: string): Record<string, unknown> {
    return {
      stripeSubscriptionId: "sub_1",
      stripeItemId: "si_1",
      tier,
      period,
      cancelAtPeriodEnd: false,
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
          {
            id: "si_1",
            current_period_end: 1_789_000_000,
            price: {
              id: "price_team_year",
              unit_amount: 79_990,
              currency: "usd",
              recurring: { interval: "year" },
            },
          },
        ],
      },
    });
  });

  for (const tier of ["pro", "team"] as const) {
    for (const period of ["month", "year"] as const) {
      it(`checks out ${tier} over ${period} with that combination's own price`, async () => {
        // A tier is sold over two prices now, and only one of them is the one
        // the reader pressed. Sending either half of the pair without the
        // other bills a period nobody chose.
        situationIs("none");
        await service.startCheckout({
          userId: USER,
          tier,
          period,
          returnUrl: RETURN_URL,
        });

        expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
          expect.objectContaining({
            line_items: [{ price: `price_${tier}_${period}`, quantity: 1 }],
          }),
        );
      });
    }
  }

  /** Every offer, in the order the grid below reads them. */
  const OFFERS = [
    { tier: "pro", period: "month" },
    { tier: "pro", period: "year" },
    { tier: "team", period: "month" },
    { tier: "team", period: "year" },
  ] as const;

  /**
   * The permitted grid, rows = held, columns = wanted, in OFFERS order.
   *
   * The same sixteen cells `canMoveTo` is asserted against in shared. A rule
   * that is right and an endpoint that never calls it would leave that suite
   * green, so this drives each cell through the endpoint itself.
   */
  const PERMITTED: readonly (readonly boolean[])[] = [
    //            PRO/m  PRO/y  Team/m Team/y
    /* PRO/m  */ [false, true, true, true],
    /* PRO/y  */ [false, false, false, true],
    /* Team/m */ [false, false, false, true],
    /* Team/y */ [false, false, false, false],
  ];

  for (const [row, from] of OFFERS.entries()) {
    for (const [column, to] of OFFERS.entries()) {
      const permitted = PERMITTED[row]?.[column] ?? false;
      const held = `${from.tier}/${from.period}`;
      const wanted = `${to.tier}/${to.period}`;

      if (permitted) {
        it(`moves ${held} to ${wanted} by swapping in that offer's price`, async () => {
          situationIs("active", holding(from.tier, from.period));
          await service.changePlan({
            userId: USER,
            tier: to.tier,
            period: to.period,
          });

          expect(stripe.subscriptions.update).toHaveBeenCalledWith(
            "sub_1",
            expect.objectContaining({
              items: [{ id: "si_1", price: `price_${to.tier}_${to.period}` }],
            }),
          );
        });
        continue;
      }

      it(`refuses ${held} to ${wanted}, and sends Stripe nothing`, async () => {
        situationIs("active", holding(from.tier, from.period));
        const same = from.tier === to.tier && from.period === to.period;
        // Two refusals, two sentences: "you are already on this one" is not
        // the same answer as "that direction is not on offer", and the status
        // code is what tells the caller which.
        await expect(
          service.changePlan({ userId: USER, tier: to.tier, period: to.period }),
        ).rejects.toBeInstanceOf(same ? ConflictError : ValidationError);
        expect(stripe.subscriptions.update).not.toHaveBeenCalled();
      });
    }
  }

  it("refuses to report a change Stripe priced differently from our list", async () => {
    // Stripe took the change and billed something our price list does not
    // sell. "Applied" is the one answer that cannot be taken back: the reader
    // is told their plan changed while the row still holds the old one, and
    // nothing afterwards contradicts it.
    situationIs("active", holding("pro", "month"));
    stripe.subscriptions.update.mockResolvedValueOnce({
      id: "sub_1",
      status: "active",
      pending_update: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      items: {
        data: [
          {
            id: "si_1",
            current_period_end: 1_789_000_000,
            price: {
              id: "price_team_month",
              // Our list says 7999 for this one.
              unit_amount: 4999,
              currency: "usd",
              recurring: { interval: "month" },
            },
          },
        ],
      },
    });

    await expect(
      service.changePlan({ userId: USER, tier: "team", period: "month" }),
    ).rejects.toThrow("server.membership.change_unconfirmed");
  });

  it("refuses the same way for a price we do not sell at all", async () => {
    // The two failures are different facts — one price is unknown, the other
    // is known and charged wrong — but from here the answer is the same: we
    // cannot say what the account now holds.
    situationIs("active", holding("pro", "month"));
    stripe.subscriptions.update.mockResolvedValueOnce({
      id: "sub_1",
      status: "active",
      pending_update: null,
      cancel_at_period_end: false,
      latest_invoice: null,
      items: {
        data: [
          {
            id: "si_1",
            current_period_end: 1_789_000_000,
            price: {
              id: "priceweknownothingabout",
              unit_amount: 7999,
              currency: "usd",
              recurring: { interval: "month" },
            },
          },
        ],
      },
    });

    await expect(
      service.changePlan({ userId: USER, tier: "team", period: "month" }),
    ).rejects.toThrow("server.membership.change_unconfirmed");
  });

  it("refuses with the key that does not say which direction", async () => {
    // `change_not_offered` covers every move `canMoveTo` refuses: a lower
    // tier, or a shorter period. The words fit both.
    situationIs("active", holding("pro", "year"));
    await expect(
      service.changePlan({ userId: USER, tier: "pro", period: "month" }),
    ).rejects.toThrow("server.membership.change_not_offered");
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
          { id: "si_1", current_period_end: 1_789_000_000, price: { id: "price_pro_month", unit_amount: 1999, currency: "usd", recurring: { interval: "month" } } },
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
      period: "month",
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

  it("又欠费又预约了取消的账号，恢复要能成", async () => {
    // 面板对这一格画的就是「恢复」。判据若问「处境叫不叫 cancelling」，答案
    // 是 retrying（欠费优先），于是服务端永远拒绝一个画得出来的按钮。要问的
    // 是「预约了取消吗」。
    situationIs("retrying", {
      stripeSubscriptionId: "sub_1",
      tier: "pro",
      period: "month",
      cancelAtPeriodEnd: true,
    });

    await service.resume(USER);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      cancel_at_period_end: false,
    });
  });

  it("已经预约了取消就不再受理取消", async () => {
    situationIs("cancelling", {
      stripeSubscriptionId: "sub_1",
      tier: "pro",
      period: "month",
      cancelAtPeriodEnd: true,
    });
    await expect(service.cancel(USER)).rejects.toBeInstanceOf(ConflictError);
  });
});
