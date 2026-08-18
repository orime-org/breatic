// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 订阅早就过期了，档位却还停在付费档（#106 §10.1）—— 真 PG。
 *
 * 档位物化在 `users.membership_tier` 上，只有 webhook 会改它，而 Stripe 的事件
 * 重试最多三天就放弃。丢掉一个「订阅结束」的事件，这个账号从此白拿会员，而且
 * 没有任何东西会发现 —— 这一侧的用户尤其不会自己去打开会员面板。
 *
 * 判据不用外部调用：真在续费的订阅，Stripe 会把 `current_period_end` 推到下一
 * 期；一行还标着活着、却停在很久以前的期末，只能是我们漏了那个事件。
 *
 * 落点是取上限的三个入口，不是展示页 —— 档位真正被兑现的七处（建 team studio、
 * 两处 studio 邀请、两处 project 邀请、建 project、并发连接）全都从这三个入口
 * 取数，一处都不经过面板。
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
  initCore,
  loadLocales,
  db,
  getLimitsForUser,
  getLimitsForStudio,
  lockLimitsForUser,
  getMembershipLimits,
  getSubscriptionStaleAfterDays,
} from "@breatic/core";

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
    connection: { application_name: "subscription-stale-tier-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A moment that many days in the past.
 * @param days - How far back.
 * @returns That moment.
 */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/**
 * Creates an account already on a paid tier.
 * @param tier - The tier its row carries.
 * @returns Its id.
 */
async function makePaidUser(tier: string): Promise<string> {
  seq += 1;
  const email = `stale-tier-${Date.now()}-${seq}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${email}, true, ${tier})
    RETURNING id
  `;
  return row!.id;
}

/**
 * Gives an account a stored subscription.
 * @param userId - Whose subscription it is.
 * @param status - Stripe's status word for it.
 * @param periodEnd - When its paid period ended, or null.
 */
async function giveSubscription(
  userId: string,
  status: string,
  periodEnd: Date | null,
): Promise<void> {
  seq += 1;
  await sql`
    INSERT INTO subscriptions
      (user_id, stripe_subscription_id, tier, status, current_period_end)
    VALUES (${userId}, ${`sub_stale_${Date.now()}_${seq}`}, 'pro', ${status},
            ${periodEnd})
  `;
}

/**
 * Removes an account and everything hanging off it.
 * @param userId - The account to remove.
 */
async function dropUser(userId: string): Promise<void> {
  await sql`DELETE FROM subscriptions WHERE user_id = ${userId}`;
  await sql`DELETE FROM studio_members WHERE user_id = ${userId}`;
  await sql`DELETE FROM studios WHERE created_by_user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

const staleDays = getSubscriptionStaleAfterDays();


describe("ceilings stop honouring a subscription nobody has heard from", () => {
  it("falls back to base when the paid period ended long ago", async () => {
    const userId = await makePaidUser("pro");
    try {
      await giveSubscription(userId, "active", daysAgo(staleDays + 3));
      expect(await getLimitsForUser(userId)).toEqual(
        getMembershipLimits("base"),
      );
    } finally {
      await dropUser(userId);
    }
  });

  it("keeps the tier while the period end is still inside the window", async () => {
    // The window is Stripe's own retry window. Taking the tier away on day
    // one would punish somebody whose card is about to go through, which is
    // the ratified rule for `past_due` (2026-08-18).
    const userId = await makePaidUser("pro");
    try {
      await giveSubscription(userId, "past_due", daysAgo(staleDays - 2));
      expect(await getLimitsForUser(userId)).toEqual(getMembershipLimits("pro"));
    } finally {
      await dropUser(userId);
    }
  });

  it("keeps the tier when the account has no subscription at all", async () => {
    // Nothing here says the tier is stale. A self-hosted install has no
    // subscriptions and every account on it must keep its ceilings; so must
    // an account moved by hand.
    const userId = await makePaidUser("pro");
    try {
      expect(await getLimitsForUser(userId)).toEqual(getMembershipLimits("pro"));
    } finally {
      await dropUser(userId);
    }
  });

  it("keeps the tier when the lapsed subscription has already ended", async () => {
    // An ended row is history, not a claim about now. Whatever put the account
    // on this tier is something else, and this check must not reach into it.
    const userId = await makePaidUser("pro");
    try {
      await giveSubscription(userId, "canceled", daysAgo(staleDays + 30));
      expect(await getLimitsForUser(userId)).toEqual(getMembershipLimits("pro"));
    } finally {
      await dropUser(userId);
    }
  });

  it("applies to the locking read as well", async () => {
    // `lockLimitsForUser` is what the create paths take before counting, so a
    // check that only covered the plain read would leave every one of them
    // still granting the stale ceilings.
    const userId = await makePaidUser("pro");
    try {
      await giveSubscription(userId, "active", daysAgo(staleDays + 3));
      const limits = await db.transaction((tx) =>
        lockLimitsForUser(userId, tx),
      );
      expect(limits).toEqual(getMembershipLimits("base"));
    } finally {
      await dropUser(userId);
    }
  });

  it("不因为一条过期的订阅行就把自部署账号降到 base", async () => {
    // 短路的判据必须是「这个档位有没有可能是订阅换来的」，不是「它等不等于
    // base」。self_hosted 是部署形态、从来不是买来的，所以任何订阅行都不该
    // 影响它 —— 而短路只判 base 的话，它会一路走到过期检查里被降成 base。
    const userId = await makePaidUser("self_hosted");
    try {
      await giveSubscription(userId, "active", daysAgo(staleDays + 3));
      expect(await getLimitsForUser(userId)).toEqual(
        getMembershipLimits("self_hosted"),
      );
    } finally {
      await dropUser(userId);
    }
  });

  it("applies to a studio through its admin", async () => {
    // A studio's ceilings are its admin's tier, so a stale subscription on
    // that account has to reach the studio too — otherwise the project and
    // member ceilings keep the numbers nobody is paying for.
    const adminId = await makePaidUser("team");
    try {
      await giveSubscription(adminId, "active", daysAgo(staleDays + 3));
      const [studio] = await sql<{ id: string }[]>`
        INSERT INTO studios (created_by_user_id, slug, type, name)
        VALUES (${adminId}, ${`stale-tier-st-${Date.now()}-${seq++}`}, 'team', 'T')
        RETURNING id
      `;
      await sql`
        INSERT INTO studio_members (studio_id, user_id, role)
        VALUES (${studio!.id}, ${adminId}, 'admin')
      `;
      expect(await getLimitsForStudio(studio!.id)).toEqual(
        getMembershipLimits("base"),
      );
    } finally {
      await dropUser(adminId);
    }
  });
});
