// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 打开会员面板时跟 Stripe 对一次账（#106 §10.2、§11）—— 真 PG，Stripe 替身。
 *
 * 档位物化在 `users.membership_tier` 上、只有 webhook 会改它，而 Stripe 的事件
 * 重试最多三天就放弃。丢一个事件，用户要么白拿会员、要么被误降，两侧各有各的
 * 兜底：白拿那侧由取上限时的过期检查抓（`subscription-stale-tier`），被误降这侧
 * 由这里抓 —— 额度不对的人第一件事就是打开面板。
 *
 * **必须同时回写订阅表，不能只改档位**：分流读的是那张表，只修档位会留下「档位
 * 对了但本地没有活订阅行」，用户下次点升级会被判成没订阅，于是在 Stripe 开出
 * 第二份订阅。
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  inject,
  vi,
} from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
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
  subscriptions: { list: vi.fn() },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

import type Stripe from "stripe";
import postgres from "postgres";
import { env, initCore, loadLocales, getUserMembershipTier } from "@breatic/core";
import { readSubscriptionSummary } from "@server/modules/subscription/subscription-panel.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  // 这个套件里有两条断言要走「这个部署卖订阅」那条分支，而集成测试的环境默认
  // 是关的。在 beforeAll 里注入（不是模块顶层）—— 别的套件在自己模块加载时
  // 调过 initCore，只有这里的调用发生在它们之后，flag 才落得住；开关一开
  // schema 就要求两个 Stripe 密钥非空，这里给占位串，本套件的 Stripe 客户端
  // 整个是替身、一次都不会真连。
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "subscription-panel-test" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  // 还回去，免得这个 flag 漏给后面跑的套件。
  initCore(process.env);
  await sql?.end({ timeout: 1 });
});

const PRO_PRICE = "price_1U5OqmGeRYMxofhepn2ij8zp";
const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

/**
 * Creates an account.
 * @param tier - The tier its row carries.
 * @param customerId - Its Stripe customer, or null for one that never paid.
 * @returns Its id.
 */
async function makeUser(
  tier: string,
  customerId: string | null,
): Promise<string> {
  seq += 1;
  const email = `sub-panel-${Date.now()}-${seq}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier, stripe_customer_id)
    VALUES (${email}, true, ${tier}, ${customerId})
    RETURNING id
  `;
  return row!.id;
}

/**
 * Removes an account and everything hanging off it.
 * @param userId - The account to remove.
 */
async function dropUser(userId: string): Promise<void> {
  await sql`DELETE FROM notifications WHERE user_id = ${userId}`;
  await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
  await sql`DELETE FROM membership_tier_changes WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

/**
 * A subscription as the Stripe SDK returns it.
 * @param over - The fields one case cares about.
 * @returns A subscription object.
 */
function stripeSub(over: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: `sub_panel_${seq}`,
    customer: "cus_x",
    status: "active",
    cancel_at_period_end: false,
    pending_update: null,
    latest_invoice: null,
    items: {
      data: [
        { id: "si_1", current_period_end: PERIOD_END, price: { id: PRO_PRICE } },
      ],
    },
    ...over,
  } as unknown as Stripe.Subscription;
}

describe("readSubscriptionSummary — an account that never paid (#106 §11)", () => {
  it("says it has no subscription, rather than saying nothing", async () => {
    // Null means "this deployment sells no subscriptions" and nothing else.
    // An account that simply has not bought one is in the state the offers
    // exist for, and answering null there is what took the buttons away from
    // exactly the people who need them.
    const userId = await makeUser("base", null);
    try {
      const summary = await readSubscriptionSummary(userId);
      expect(summary?.state).toBe("none");
      expect(summary?.tier).toBe("base");
      // Nothing to reconcile against: no customer, so no Stripe call.
      expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    } finally {
      await dropUser(userId);
    }
  });
});

describe("readSubscriptionSummary — reconciling (#106 §10.2)", () => {
  it("puts back a tier a lost event never granted", async () => {
    const userId = await makeUser("base", `cus_panel_a_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockResolvedValueOnce({
        data: [stripeSub({ id: `sub_lost_${seq}` })],
      });

      const summary = await readSubscriptionSummary(userId);

      expect(await getUserMembershipTier(userId)).toBe("pro");
      expect(summary?.state).toBe("active");
      expect(summary?.tier).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });

  it("writes the subscription row too, not only the tier", async () => {
    // Only fixing the tier leaves "on PRO but with no live subscription
    // stored", and the next upgrade click is judged as having no subscription
    // — which opens a SECOND subscription at Stripe.
    const userId = await makeUser("base", `cus_panel_b_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockResolvedValueOnce({
        data: [stripeSub({ id: `sub_row_${seq}` })],
      });

      await readSubscriptionSummary(userId);

      const rows = await sql<{ status: string; tier: string }[]>`
        SELECT status, tier FROM subscriptions WHERE user_id = ${userId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ status: "active", tier: "pro" });
    } finally {
      await dropUser(userId);
    }
  });

  it("takes a tier away when Stripe says the subscription is over", async () => {
    const userId = await makeUser("pro", `cus_panel_c_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockResolvedValueOnce({
        data: [stripeSub({ id: `sub_gone_${seq}`, status: "canceled" })],
      });

      const summary = await readSubscriptionSummary(userId);

      expect(await getUserMembershipTier(userId)).toBe("base");
      expect(summary?.state).toBe("none");
      const bells = await sql<{ type: string }[]>`
        SELECT type FROM notifications WHERE user_id = ${userId}
      `;
      expect(bells.map((b) => b.type)).toEqual(["membership.ended"]);
    } finally {
      await dropUser(userId);
    }
  });

  it("leaves everything alone when Stripe agrees with us", async () => {
    const userId = await makeUser("pro", `cus_panel_d_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockResolvedValue({
        data: [stripeSub({ id: `sub_same_${seq}` })],
      });
      await readSubscriptionSummary(userId);
      await readSubscriptionSummary(userId);

      const ledger = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM membership_tier_changes
        WHERE user_id = ${userId}
      `;
      // One move: base was never involved, and the second read changed nothing.
      expect(ledger[0]?.count).toBe("0");
      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("readSubscriptionSummary — what the panel is told (#106 §11)", () => {
  it("gives the situation rather than Stripe's raw status", async () => {
    // `active` alone cannot tell "running", "ending" and "upgrade unpaid"
    // apart, and the panel shows something different for each.
    const userId = await makeUser("pro", `cus_panel_e_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockResolvedValueOnce({
        data: [
          stripeSub({ id: `sub_cancel_${seq}`, cancel_at_period_end: true }),
        ],
      });

      const summary = await readSubscriptionSummary(userId);

      expect(summary?.state).toBe("cancelling");
      expect(summary?.cancelAtPeriodEnd).toBe(true);
      expect(summary?.currentPeriodEnd).toBe(
        new Date(PERIOD_END * 1000).toISOString(),
      );
    } finally {
      await dropUser(userId);
    }
  });

  it("hands over the payment link while a charge is being retried", async () => {
    // The other half of keeping the tier through `past_due`: the person has to
    // be able to see what happened and pay it themselves.
    const userId = await makeUser("pro", `cus_panel_f_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockResolvedValueOnce({
        data: [
          stripeSub({
            id: `sub_due_${seq}`,
            status: "past_due",
            latest_invoice: {
              status: "open",
              hosted_invoice_url: "https://invoice.example/pay",
            },
          }),
        ],
      });

      const summary = await readSubscriptionSummary(userId);

      expect(summary?.state).toBe("retrying");
      expect(summary?.payableInvoiceUrl).toBe("https://invoice.example/pay");
      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("readAccountMembership —— 面板这一次的答案 (#106 §10.2、§11)", () => {
  it("返回的是对账之后的档位和上限，不是纠正前的旧值", async () => {
    // 前置断言：flag 没落住的话下面整条断言链都测不到要测的分支，会变成
    // 一条假绿。这一行让那种情况当场失败，而不是悄悄通过。
    expect(env.PAYMENT_ENABLED, "本套件需要支付开关是开的").toBe(true);
    // 第 13 条要的是「就地纠正」。纠正只改了库、这一次的响应仍是旧值的话，
    // 用户这一次看到的还是错的档位，而且据此点出去的按钮必然被服务端拒。
    const userId = await makeUser("base", `cus_order_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockResolvedValueOnce({
        data: [stripeSub({ id: `sub_order_${seq}` })],
      });

      const membership = await readAccountMembership(userId);

      expect(membership.tier).toBe("pro");
      expect(membership.subscription?.tier).toBe("pro");
      // 上限也得是纠正之后那一档的：PRO 的团队 studio 上限不是 base 的 0。
      expect(membership.limits?.team_studios).toBeGreaterThan(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("Stripe 打不通时面板照常打开，只是订阅那部分退回本地已知的状态", async () => {
    expect(env.PAYMENT_ENABLED, "本套件需要支付开关是开的").toBe(true);
    // 档位、额度、对比表跟 Stripe 毫无关系。对账是增强，不该把整张面板拖下水。
    const userId = await makeUser("pro", `cus_down_${Date.now()}`);
    try {
      stripe.subscriptions.list.mockRejectedValueOnce(
        new Error("Stripe is unreachable"),
      );

      const membership = await readAccountMembership(userId);

      expect(membership.tier).toBe("pro");
      expect(membership.limits?.team_studios).toBeGreaterThan(0);
      expect(membership.catalog).toHaveLength(3);
    } finally {
      await dropUser(userId);
    }
  });
});
