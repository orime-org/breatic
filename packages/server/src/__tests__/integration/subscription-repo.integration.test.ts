// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 订阅行的读写（#106 §5.2）—— 真 PG。
 *
 * 写的那一面只有一个动作：拿 Stripe 给的当前状态，把这条订阅写成那个样子。
 * 它必须**按 Stripe 的订阅 id 收敛到一行** —— 事件会重复送达、会乱序、对账
 * 还会再写一遍同一条订阅，这几条路径全都经这一个函数；它要是每次插一行，
 * 一个账号就会读出好几份会员。
 *
 * 读的那一面要跟状态判定接得上：查出来的行原样喂给 `subscriptionSituation`
 * 就能得出处境。这里连着测这一步，是因为「行存对了」和「处境读对了」各自
 * 绿着、中间接线断掉，是单测永远看不见的那种失败。
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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

import postgres from "postgres";
import {
  db,
  initCore,
  listSubscriptions,
  upsertSubscription,
  subscriptionSituation,
  tierForSituation,
} from "@breatic/core";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "subscription-repo-test-driver" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * Creates a throwaway account.
 * @returns Its id.
 */
async function makeUser(): Promise<string> {
  seq += 1;
  const email = `sub-repo-${Date.now()}-${seq}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${email}, true)
    RETURNING id
  `;
  return row!.id;
}

/**
 * Removes an account and everything hanging off it.
 * @param userId - The account to remove.
 */
async function dropUser(userId: string): Promise<void> {
  await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

describe("upsertSubscription (#106 §5.2)", () => {
  it("writes a subscription nobody has seen before", async () => {
    const userId = await makeUser();
    try {
      const periodEnd = new Date("2026-09-18T00:00:00.000Z");
      const stored = await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub_new_${seq}`,
        tier: "pro",
        status: "active",
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        stripeItemId: "si_1",
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });

      expect(stored.tier).toBe("pro");
      expect(stored.status).toBe("active");
      expect(stored.currentPeriodEnd?.toISOString()).toBe(
        periodEnd.toISOString(),
      );
      expect(stored.stripeItemId).toBe("si_1");
    } finally {
      await dropUser(userId);
    }
  });

  it("converges on one row per Stripe subscription", async () => {
    // The webhook, the reconciliation and a redelivery of the same event all
    // arrive here. A second row would read as a second membership.
    const userId = await makeUser();
    const stripeId = `sub_conv_${Date.now()}`;
    try {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: stripeId,
        tier: "pro",
        status: "incomplete",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        stripeItemId: "si_1",
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: "https://invoice.example/1",
      });
      const updated = await upsertSubscription({
        userId,
        stripeSubscriptionId: stripeId,
        tier: "pro",
        status: "active",
        currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        stripeItemId: "si_1",
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });

      expect(updated.status).toBe("active");
      // Cleared, not left behind: the invoice was paid, and a stale link would
      // put "finish paying" on the panel of somebody who is up to date.
      expect(updated.payableInvoiceUrl).toBeNull();
      expect(await listSubscriptions(userId)).toHaveLength(1);
    } finally {
      await dropUser(userId);
    }
  });
});

describe("listSubscriptions (#106 §5.2)", () => {
  it("returns every subscription the account has held, newest first", async () => {
    const userId = await makeUser();
    try {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub_first_${seq}`,
        tier: "pro",
        status: "canceled",
        currentPeriodEnd: new Date("2026-07-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });
      await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub_second_${seq}`,
        tier: "team",
        status: "active",
        currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });

      const rows = await listSubscriptions(userId);
      expect(rows.map((r) => r.status)).toEqual(["active", "canceled"]);
    } finally {
      await dropUser(userId);
    }
  });

  it("feeds the state reading directly", async () => {
    // The wiring, not either half: rows come out of the database and go into
    // the reading unchanged, and the account's tier follows from that.
    const userId = await makeUser();
    try {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub_wired_${seq}`,
        tier: "team",
        status: "active",
        currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
        cancelAtPeriodEnd: true,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });

      const { situation, record } = subscriptionSituation(
        await listSubscriptions(userId),
      );
      expect(situation).toBe("cancelling");
      expect(tierForSituation(situation, record)).toBe("team");
    } finally {
      await dropUser(userId);
    }
  });

  it("同一个事务里连写两行，处境判定仍挑得出那条活的", async () => {
    // `created_at` 默认取 `now()`，而 `now()` 在一个事务里是**事务开始时刻**，
    // 同事务写的行时间戳一模一样，UUID 主键也不单调 —— 靠排序挑行本来就靠
    // 不住。而 webhook 正是在一个事务里写订阅行、紧接着读回来判档位的。
    // 治法不是找一个更好的排序键，是让「一个账号最多一条活订阅」真正成立：
    // 只要它成立，挑哪一条就没有歧义可言。
    const userId = await makeUser();
    const older = `sub_tx_a_${Date.now()}`;
    const newer = `sub_tx_b_${Date.now()}`;
    try {
      await db.transaction(async (tx) => {
        await upsertSubscription(
          {
            userId,
            stripeSubscriptionId: older,
            tier: "pro",
            status: "canceled",
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            stripeItemId: null,
            hasPendingUpdate: false,
            pendingTier: null,
            payableInvoiceUrl: null,
          },
          tx,
        );
        await upsertSubscription(
          {
            userId,
            stripeSubscriptionId: newer,
            tier: "team",
            status: "active",
            currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
            cancelAtPeriodEnd: false,
            stripeItemId: null,
            hasPendingUpdate: false,
            pendingTier: null,
            payableInvoiceUrl: null,
          },
          tx,
        );
        const rows = await listSubscriptions(userId, tx);
        const { situation, record } = subscriptionSituation(rows);
        expect(situation).toBe("active");
        expect(record?.stripeSubscriptionId).toBe(newer);
      });
    } finally {
      await dropUser(userId);
    }
  });

  it("answers with nothing for an account that has never subscribed", async () => {
    const userId = await makeUser();
    try {
      expect(await listSubscriptions(userId)).toEqual([]);
      expect(subscriptionSituation(await listSubscriptions(userId)).situation).toBe(
        "none",
      );
    } finally {
      await dropUser(userId);
    }
  });

  it("leaves out rows that were soft-deleted", async () => {
    const userId = await makeUser();
    const stripeId = `sub_soft_${Date.now()}`;
    try {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: stripeId,
        tier: "pro",
        status: "active",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });
      await sql`
        UPDATE subscriptions SET deleted_at = now()
        WHERE stripe_subscription_id = ${stripeId}
      `;
      expect(await listSubscriptions(userId)).toEqual([]);
    } finally {
      await dropUser(userId);
    }
  });
});

describe("一个账号最多一条活订阅 (#106 §6.5.5)", () => {
  it("拒绝给已经有活订阅的账号再插一条", async () => {
    // 设计点名的那道兜底。没有它，并发两次结账或者一个乱序事件就能让库里
    // 躺着两条活订阅，而读侧只会静默挑一条 —— 挑中哪条决定这个人拿到哪一
    // 档，而两条都是他付过钱的。
    const userId = await makeUser();
    try {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub_live_a_${Date.now()}`,
        tier: "pro",
        status: "active",
        currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });

      await expect(
        upsertSubscription({
          userId,
          stripeSubscriptionId: `sub_live_b_${Date.now()}`,
          tier: "team",
          status: "active",
          currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
          cancelAtPeriodEnd: false,
          stripeItemId: null,
          hasPendingUpdate: false,
          pendingTier: null,
          payableInvoiceUrl: null,
        }),
      ).rejects.toThrow(/live subscription/i);
    } finally {
      await dropUser(userId);
    }
  });

  it("更新那条活订阅自己不算违反", async () => {
    // 守卫拦的是「再来一条」，不是「改现有这条」—— webhook 每次都在改它。
    const userId = await makeUser();
    const stripeId = `sub_same_live_${Date.now()}`;
    try {
      const write = {
        userId,
        stripeSubscriptionId: stripeId,
        tier: "pro" as const,
        status: "active" as const,
        currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      };
      await upsertSubscription(write);
      const again = await upsertSubscription({ ...write, status: "past_due" });
      expect(again.status).toBe("past_due");
    } finally {
      await dropUser(userId);
    }
  });

  it("上一条已经终结之后，可以再订一条", async () => {
    // 验收第 7 条：老用户回来续费。终结的那条留着当账本，不挡新的。
    const userId = await makeUser();
    try {
      await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub_done_${Date.now()}`,
        tier: "pro",
        status: "canceled",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });
      const fresh = await upsertSubscription({
        userId,
        stripeSubscriptionId: `sub_again_${Date.now()}`,
        tier: "team",
        status: "active",
        currentPeriodEnd: new Date("2026-09-18T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        stripeItemId: null,
        hasPendingUpdate: false,
        pendingTier: null,
        payableInvoiceUrl: null,
      });
      expect(fresh.tier).toBe("team");
      expect(await listSubscriptions(userId)).toHaveLength(2);
    } finally {
      await dropUser(userId);
    }
  });
});
