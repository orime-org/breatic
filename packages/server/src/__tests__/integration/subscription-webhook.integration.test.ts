// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Stripe 送来的订阅事件（#106 §8）—— 真 PG，Stripe 客户端替身。
 *
 * 这一层的三件事都只有真库能证：
 *
 * 一、**幂等靠主键**。同一个 event id 插第二次冲突，整个事务作废，所以档位不会
 * 变两次、账本不会多一行。比档位是不是「已经等于目标值」不管用——那种比较收敛
 * 到最后一次调用，分不出重放和新事件。
 *
 * 二、**乱序不看事件负载**。我们收到事件后回头问 Stripe 当前是什么样，所以先到
 * 的旧事件和后到的新事件问到的是同一个当前值，顺序不再重要。
 *
 * 三、**认人**。订阅事件上不带任何我们的标识，只有 customer；先建 customer 再
 * 结账就是为了这一步。
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
  subscriptions: { retrieve: vi.fn() },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

// 邮件那一半被替身顶掉，好让测试断言它真的被调了。它此前一条测试都没有：
// 把两个调用点整个删掉，全仓一条都不红。铃铛是保底通道、邮件是增强，两个
// 都属于「掉回免费档要通知用户」这条验收，所以两个都要有人钉着。
const sentMail = vi.fn();

vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: (
    build: () => Promise<unknown>,
    ctx: Record<string, unknown>,
  ) => sentMail(build, ctx),
}));

import type Stripe from "stripe";
import postgres from "postgres";
import { initCore, loadLocales, getUserMembershipTier } from "@breatic/core";
import { upsertSubscription } from "@breatic/core";
import { handleSubscriptionEvent } from "@server/modules/subscription/subscription-events.js";
import { readStripeSubscription } from "@server/modules/subscription/read-stripe-subscription.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "subscription-webhook-test" },
  });
});

beforeEach(() => {
  // Call counts only: the double's implementations are set per case.
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const PRO_PRICE = "price_1U5OqmGeRYMxofhepn2ij8zp";
const TEAM_PRICE = "price_1U5OrkGeRYMxofhepeUDWhqB";
const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

/**
 * Creates an account already known to Stripe.
 * @returns Its id and its Stripe customer id.
 */
async function makeCustomerAccount(): Promise<{
  userId: string;
  customerId: string;
}> {
  seq += 1;
  const email = `sub-hook-${Date.now()}-${seq}@example.test`;
  const customerId = `cus_hook_${Date.now()}_${seq}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, stripe_customer_id)
    VALUES (${email}, true, ${customerId})
    RETURNING id
  `;
  return { userId: row!.id, customerId };
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
    id: `sub_hook_${seq}`,
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

/**
 * A webhook event carrying a subscription.
 * @param type - The event type.
 * @param subscription - The subscription it names.
 * @param id - The event id.
 * @returns A Stripe event.
 */
function event(
  type: string,
  subscription: Stripe.Subscription,
  id: string,
): Stripe.Event {
  return {
    id,
    type,
    data: { object: subscription },
  } as unknown as Stripe.Event;
}

describe("handleSubscriptionEvent — identifying the account (#106 §7.1)", () => {
  it("finds the account from the customer on the subscription", async () => {
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const sub = stripeSub({ id: `sub_id_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(sub);

      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.created", sub, `evt_id_${seq}`),
      );

      expect(outcome.status).toBe("applied");
      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });

  it("prefers the account id Stripe carried on the subscription itself", async () => {
    // The second identification line: metadata put there at checkout. It wins
    // because it is ours, where the customer is a join we maintain.
    const { userId } = await makeCustomerAccount();
    try {
      const sub = stripeSub({
        id: `sub_meta_${seq}`,
        customer: "cus_not_ours",
        metadata: { userId },
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(sub);

      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.created", sub, `evt_meta_${seq}`),
      );

      expect(outcome.status).toBe("applied");
      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });

  it("问 Stripe 时带着上限，而且不重试", async () => {
    // 跟对账那次同一个道理，而且这条更硬：Stripe 判定这次投递失败之后会自己
    // 重投，此时还挂在这儿的请求已经没人在等了。它自己的两次重试分别在超时后
    // 约半秒和一秒触发，对一个真的变慢的 Stripe 毫无用处，白等 160 秒。
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const sub = stripeSub({ id: `sub_timeout_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(sub);
      await handleSubscriptionEvent(
        event("customer.subscription.created", sub, `evt_timeout_${Date.now()}`),
      );

      const [, , options] = stripe.subscriptions.retrieve.mock.calls[0] as [
        unknown,
        unknown,
        { timeout?: number; maxNetworkRetries?: number } | undefined,
      ];
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(10_000);
      expect(options?.maxNetworkRetries).toBe(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("ignores an event whose customer belongs to nobody here", async () => {
    const sub = stripeSub({ id: `sub_alien_${seq}`, customer: "cus_alien" });
    const outcome = await handleSubscriptionEvent(
      event("customer.subscription.created", sub, `evt_alien_${Date.now()}`),
    );
    expect(outcome.status).toBe("noop");
  });
});

describe("handleSubscriptionEvent — idempotency (#106 §8)", () => {
  it("applies a redelivered event exactly once", async () => {
    // Acceptance item 4. Comparing tiers cannot tell a replay from a new
    // event, so the guard is the event id's primary key.
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const sub = stripeSub({ id: `sub_dup_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValue(sub);
      const evt = event(
        "customer.subscription.created",
        sub,
        `evt_dup_${Date.now()}`,
      );

      const first = await handleSubscriptionEvent(evt);
      const second = await handleSubscriptionEvent(evt);

      expect(first.status).toBe("applied");
      expect(second.status).toBe("replay");
      const ledger = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM membership_tier_changes
        WHERE user_id = ${userId}
      `;
      expect(ledger[0]?.count).toBe("1");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — out of order (#106 §8)", () => {
  it("writes what Stripe says now, not what the late event carried", async () => {
    // An event that arrives after a newer one still asks for the current
    // state, so it cannot put the old status back.
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const current = stripeSub({
        id: `sub_ord_${seq}`,
        customer: customerId,
        status: "active",
        items: {
          data: [
            {
              id: "si_1",
              current_period_end: PERIOD_END,
              price: { id: TEAM_PRICE },
            },
          ],
        },
      });
      stripe.subscriptions.retrieve.mockResolvedValue(current);

      // The event payload is the OLD snapshot: pro, and merely incomplete.
      const stale = stripeSub({
        id: current.id,
        customer: customerId,
        status: "incomplete",
      });
      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.updated", stale, `evt_ord_${Date.now()}`),
      );

      expect(outcome.status).toBe("applied");
      expect(await getUserMembershipTier(userId)).toBe("team");
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM subscriptions WHERE user_id = ${userId}
      `;
      expect(row?.status).toBe("active");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — falling back to base (#106 §9)", () => {
  it("moves the account to base and rings the bell when the plan ends", async () => {
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const live = stripeSub({ id: `sub_end_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(live);
      await handleSubscriptionEvent(
        event("customer.subscription.created", live, `evt_end_a_${Date.now()}`),
      );
      expect(await getUserMembershipTier(userId)).toBe("pro");

      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: live.id, customer: customerId, status: "canceled" }),
      );
      await handleSubscriptionEvent(
        event("customer.subscription.deleted", live, `evt_end_b_${Date.now()}`),
      );

      expect(await getUserMembershipTier(userId)).toBe("base");
      const bells = await sql<{ type: string; payload: unknown }[]>`
        SELECT type, payload FROM notifications WHERE user_id = ${userId}
      `;
      expect(bells.map((b) => b.type)).toEqual(["membership.ended"]);
      expect(bells[0]?.payload).toEqual({ fromTier: "pro" });
      // 邮件在事务提交之后发，收件人是这个账号，标题标记说明它是哪一封。
      expect(sentMail).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ userId, subject: "membership_ended" }),
      );
    } finally {
      await dropUser(userId);
    }
  });

  it("keeps the paid tier while Stripe is still retrying the card", async () => {
    // Ratified 2026-08-18: `past_due` is the window in which Stripe collects
    // for us, and none of Notion, Figma or Slack downgrades on day one.
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const live = stripeSub({ id: `sub_due_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(live);
      await handleSubscriptionEvent(
        event("customer.subscription.created", live, `evt_due_a_${Date.now()}`),
      );

      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: live.id, customer: customerId, status: "past_due" }),
      );
      await handleSubscriptionEvent(
        event("customer.subscription.updated", live, `evt_due_b_${Date.now()}`),
      );

      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — an upgrade that went unpaid (#106 §7.3)", () => {
  it("keeps the old tier and says the upgrade did not complete", async () => {
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const pending = stripeSub({
        id: `sub_pend_${seq}`,
        customer: customerId,
        pending_update: {
          expires_at: 0,
          subscription_items: [{ id: "si_1", price: { id: TEAM_PRICE } }],
        },
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(pending);
      await handleSubscriptionEvent(
        event("customer.subscription.updated", pending, `evt_p_a_${Date.now()}`),
      );
      // The upgrade has not been paid, so the ceilings are still PRO's.
      expect(await getUserMembershipTier(userId)).toBe("pro");

      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: pending.id, customer: customerId }),
      );
      await handleSubscriptionEvent(
        event(
          "customer.subscription.pending_update_expired",
          pending,
          `evt_p_b_${Date.now()}`,
        ),
      );

      expect(await getUserMembershipTier(userId)).toBe("pro");
      const bells = await sql<{ type: string; payload: unknown }[]>`
        SELECT type, payload FROM notifications WHERE user_id = ${userId}
      `;
      expect(bells.map((b) => b.type)).toEqual([
        "membership.upgrade_incomplete",
      ]);
      expect(bells[0]?.payload).toEqual({ toTier: "team" });
    } finally {
      await dropUser(userId);
    }
  });

  it("就算别人先一步把待付标记清掉了，这条通知照样发得出来", async () => {
    // 通知的依据不能是「我写库前读到的那一行」—— 面板对账或者兄弟事件先提交
    // 一次，那一行就已经没有 pendingTier 了，通知从此凭空消失。事件负载里带
    // 着那次升级要去哪一档，那才是它自己的事实。
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const lapsed = stripeSub({
        id: `sub_lapse_${seq}`,
        customer: customerId,
        pending_update: {
          expires_at: 0,
          subscription_items: [{ id: "si_1", price: { id: TEAM_PRICE } }],
        },
      });
      // 库里那一行是干净的：待付标记已经被别的写入方清掉了。
      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: lapsed.id, customer: customerId }),
      );
      await handleSubscriptionEvent(
        event("customer.subscription.created", lapsed, `evt_lap_a_${Date.now()}`),
      );

      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: lapsed.id, customer: customerId }),
      );
      await handleSubscriptionEvent(
        event(
          "customer.subscription.pending_update_expired",
          lapsed,
          `evt_lap_b_${Date.now()}`,
        ),
      );

      const bells = await sql<{ type: string; payload: unknown }[]>`
        SELECT type, payload FROM notifications WHERE user_id = ${userId}
      `;
      expect(bells.map((b) => b.type)).toEqual([
        "membership.upgrade_incomplete",
      ]);
      expect(bells[0]?.payload).toEqual({ toTier: "team" });
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — 哪些事件归这条腿 (#106 §8)", () => {
  /**
   * 一个结账完成事件。
   * @param mode - 那次结账是买订阅还是买积分包。
   * @param id - 事件 id。
   * @returns 一个 Stripe 事件。
   */
  function checkoutEvent(mode: string, id: string): Stripe.Event {
    return {
      id,
      type: "checkout.session.completed",
      data: { object: { id: `cs_${mode}_${seq}`, mode } },
    } as unknown as Stripe.Event;
  }

  it("认领订阅模式的结账完成事件，即便它什么都不用做", async () => {
    // 这条是真机上打出 404 的那一条：`checkout.session.completed` 不在订阅
    // 事件表里，于是被判成「不归我」，落到积分包那条分支去查 payments 行 ——
    // 而订阅结账从不写那张表，于是 NotFoundError 变成 webhook 的 404，
    // Stripe 重投三天后停掉整个端点。它必须由这条腿认下并回 200。
    // 状态是 `acknowledged` 不是 `noop`：这是每一次成功的会员结账都会产生
    // 的那一条，是这条腿说得最多的一句正常话。`noop` 留给真出事的那两种
    // （认不出账号、不认识的价格），路由据此决定记 warn 还是 info。
    const outcome = await handleSubscriptionEvent(
      checkoutEvent("subscription", `evt_cs_sub_${Date.now()}`),
    );
    expect(outcome.status).toBe("acknowledged");
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("把积分包那次结账留给积分包的处理器", async () => {
    const outcome = await handleSubscriptionEvent(
      checkoutEvent("payment", `evt_cs_pay_${Date.now()}`),
    );
    expect(outcome.status).toBe("notMine");
  });

  it("不认领跟订阅无关的事件", async () => {
    const outcome = await handleSubscriptionEvent(
      event("invoice.paid", stripeSub(), `evt_other_${Date.now()}`),
    );
    expect(outcome.status).toBe("notMine");
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("认不出归属的订阅事件由这条腿认下，并给出说得清的理由", async () => {
    // 认领了才有人记日志：判成「不归我」的话它会掉进积分包分支，那边对它
    // 只有一个 default: break，连事件 id 都不会留下。
    const sub = stripeSub({ id: `sub_alien2_${seq}`, customer: "cus_alien2" });
    const outcome = await handleSubscriptionEvent(
      event("customer.subscription.created", sub, `evt_alien2_${Date.now()}`),
    );
    expect(outcome.status).toBe("noop");
    expect(outcome.status === "noop" && outcome.reason).toMatch(/customer/);
  });

  it("卖的是不认识的 price 时，认下事件但不处理，且不标成已处理", async () => {
    // An operator could add a price in Stripe that this deployment's config
    // does not know. Marking the event handled would drop it for good; leaving
    // it unmarked keeps a manual redelivery able to fix things.
    const { userId, customerId } = await makeCustomerAccount();
    const eventId = `evt_price_${Date.now()}`;
    try {
      const sub = stripeSub({
        id: `sub_price_${seq}`,
        customer: customerId,
        items: {
          data: [
            {
              id: "si_1",
              current_period_end: PERIOD_END,
              price: { id: "price_never_configured" },
            },
          ],
        },
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(sub);

      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.created", sub, eventId),
      );

      expect(outcome.status).toBe("noop");
      const marks = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM stripe_webhook_events
        WHERE event_id = ${eventId}
      `;
      expect(marks[0]?.count).toBe("0");
      expect(await getUserMembershipTier(userId)).toBe("base");
    } finally {
      await sql`DELETE FROM stripe_webhook_events WHERE event_id = ${eventId}`;
      await dropUser(userId);
    }
  });
});

describe("并发写入：后取到的快照说了算 (#106 §6.5.5)", () => {
  it("一个拿着旧快照的写入方，覆盖不掉已经写进去的新状态", async () => {
    // 两条路径都会写这张表：webhook 和面板对账。两边都是「先问 Stripe、再写
    // 库」，所以先问的那个可能后写 —— 它手里那份是旧的。判据不能是谁后提交，
    // 只能是谁的快照更新。
    const { userId, customerId } = await makeCustomerAccount();
    const stripeId = `sub_ver_${Date.now()}`;
    try {
      const newer = stripeSub({
        id: stripeId,
        customer: customerId,
        status: "active",
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(newer);
      await handleSubscriptionEvent(
        event("customer.subscription.updated", newer, `evt_ver_a_${Date.now()}`),
      );
      expect(await getUserMembershipTier(userId)).toBe("pro");

      // 另一个写入方手里那份是更早取到的：它说这条订阅还没付成。
      const stale = readStripeSubscription(
        stripeSub({ id: stripeId, customer: customerId, status: "incomplete" }),
        userId,
      );
      await upsertSubscription({
        ...stale!,
        observedAt: new Date(Date.now() - 60_000),
      });

      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM subscriptions WHERE stripe_subscription_id = ${stripeId}
      `;
      expect(row?.status).toBe("active");
    } finally {
      await dropUser(userId);
    }
  });
});
