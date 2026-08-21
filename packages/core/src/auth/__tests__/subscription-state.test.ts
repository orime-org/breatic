// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What an account's subscription rows mean (task #106, design §6.5.1).
 *
 * Two questions get answered here, and keeping them apart is the point. The
 * first is WHICH SITUATION the account is in, and it has seven answers rather
 * than Stripe's `active`: an account that has scheduled a cancellation and one
 * that has an unpaid upgrade are both `active` at Stripe, yet what each may do
 * next is different, and the earlier design collapsed them into one state and
 * left those cells of the transition table unwritten.
 *
 * The second is WHICH TIER that situation entitles the account to. It is a
 * separate question because two situations that differ in what the account may
 * do can still give the same tier — `past_due` keeps the paid tier while Stripe
 * retries, which is a ratified decision (2026-08-18), not an oversight.
 *
 * Driven directly rather than through stored rows: this is a pure reading of
 * rows the caller already holds, and the integration suite is where "are these
 * two still wired into the read paths" gets asked.
 */

import { describe, it, expect } from "vitest";

import {
  subscriptionSituation,
  tierForSituation,
  type SubscriptionRecord,
} from "../subscription-state.js";

/**
 * A row in the state the tests keep saying: active, paid for, nothing pending.
 * @param over - Fields this particular case cares about.
 * @returns One subscription record.
 */
function row(over: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    stripeSubscriptionId: "sub_1",
    status: "active",
    tier: "pro",
    cancelAtPeriodEnd: false,
    hasPendingUpdate: false,
    currentPeriodEnd: new Date("2026-09-17T00:00:00Z"),
    ...over,
  };
}

describe("subscriptionSituation (#106 §6.5.1)", () => {
  it("reports no live subscription when the account has never had one", () => {
    expect(subscriptionSituation([]).situation).toBe("none");
  });

  it("reports no live subscription when every row has ended", () => {
    const rows = [
      row({ status: "canceled" }),
      row({ stripeSubscriptionId: "sub_2", status: "incomplete_expired" }),
      row({ stripeSubscriptionId: "sub_3", status: "unpaid" }),
    ];
    expect(subscriptionSituation(rows).situation).toBe("none");
  });

  it("separates a scheduled cancellation from an ordinary active plan", () => {
    expect(subscriptionSituation([row()]).situation).toBe("active");
    expect(
      subscriptionSituation([row({ cancelAtPeriodEnd: true })]).situation,
    ).toBe("cancelling");
  });

  it("separates an unpaid upgrade from an ordinary active plan", () => {
    expect(
      subscriptionSituation([row({ hasPendingUpdate: true })]).situation,
    ).toBe("upgradePending");
  });

  it("reports both when a cancellation is scheduled and an upgrade is unpaid", () => {
    // Cancelling wins: the plan is ending, and that decides what the panel
    // offers. The unpaid upgrade is still visible through the row.
    const { situation, record } = subscriptionSituation([
      row({ cancelAtPeriodEnd: true, hasPendingUpdate: true }),
    ]);
    expect(situation).toBe("cancelling");
    expect(record?.hasPendingUpdate).toBe(true);
  });

  it("reports the first invoice as unsettled rather than as a live plan", () => {
    expect(subscriptionSituation([row({ status: "incomplete" })]).situation).toBe(
      "firstPaymentUnsettled",
    );
  });

  it("reports a retrying charge", () => {
    expect(subscriptionSituation([row({ status: "past_due" })]).situation).toBe(
      "retrying",
    );
  });

  it("reports states we never create as unexpected, not as live", () => {
    // We set no trial, so neither of these can arise from anything we do.
    // They must not block the account from subscribing.
    expect(subscriptionSituation([row({ status: "trialing" })]).situation).toBe(
      "unexpected",
    );
    expect(subscriptionSituation([row({ status: "paused" })]).situation).toBe(
      "unexpected",
    );
  });

  it("reports a status this build does not know as unexpected, not as none", () => {
    // The column is a varchar holding Stripe's own word, so a status added
    // upstream reaches this reading before any of our code knows it. Reading
    // it as `none` would be the harmful answer: the account is still being
    // billed, and the panel would offer to start a second subscription.
    expect(
      subscriptionSituation([
        row({ status: "some_status_stripe_added" }),
      ]).situation,
    ).toBe("unexpected");
  });

  it("ignores ended rows when a live one is present", () => {
    // An account that cancelled and subscribed again keeps the old row as a
    // ledger entry; it must not be what decides the situation.
    const { situation, record } = subscriptionSituation([
      row({ stripeSubscriptionId: "sub_old", status: "canceled", tier: "pro" }),
      row({ stripeSubscriptionId: "sub_new", status: "active", tier: "team" }),
    ]);
    expect(situation).toBe("active");
    expect(record?.stripeSubscriptionId).toBe("sub_new");
  });

  it("returns the live record so callers need not search again", () => {
    expect(subscriptionSituation([row()]).record?.tier).toBe("pro");
    expect(subscriptionSituation([]).record).toBeNull();
  });
});

describe("tierForSituation (#106 §6.5.1)", () => {
  it("gives the purchased tier while the plan is in good standing", () => {
    expect(tierForSituation("active", row({ tier: "team" }))).toBe("team");
  });

  it("keeps the purchased tier through a scheduled cancellation", () => {
    // Paid through the end of the period; nothing is taken back early.
    expect(tierForSituation("cancelling", row({ tier: "team" }))).toBe("team");
  });

  it("keeps the purchased tier while Stripe retries the charge", () => {
    // Ratified 2026-08-18: past_due is the window in which Stripe is still
    // collecting for us, and none of Notion, Figma or Slack downgrades on the
    // day a card fails.
    expect(tierForSituation("retrying", row({ tier: "pro" }))).toBe("pro");
  });

  it("gives the tier already paid for, not the one being upgraded to", () => {
    // The upgrade has not been paid; granting its ceilings would hand out
    // capacity nobody paid for.
    expect(
      tierForSituation("upgradePending", row({ tier: "pro" })),
    ).toBe("pro");
  });

  it("gives base for a first invoice that has not settled", () => {
    expect(
      tierForSituation("firstPaymentUnsettled", row({ tier: "team" })),
    ).toBe("base");
  });

  it("gives base when there is no live subscription", () => {
    expect(tierForSituation("none", null)).toBe("base");
  });

  it("gives base for states we never create", () => {
    expect(tierForSituation("unexpected", row({ tier: "team" }))).toBe("base");
  });
});

describe("subscriptionSituation — 两条都活着的时候挑哪一条", () => {
  // 这张表是 Stripe 的镜像，而 Stripe 允许一个客户同时有两条活订阅（两个
  // 标签页各完成一次结账就够）。以前这里挑的是「传进来的第一条」，靠调用方
  // 按新旧排序 —— 而 created_at 是事务开始时间、同一个事务里写的两行完全相
  // 等，主键又是随机 UUID，所以那个顺序根本立不住。现在的判据跟插入顺序无关。

  const pro = row({ stripeSubscriptionId: "sub_pro", tier: "pro" });
  const team = row({ stripeSubscriptionId: "sub_team", tier: "team" });

  it("给高的那一档：两份都在扣他的钱", () => {
    expect(subscriptionSituation([pro, team]).record?.tier).toBe("team");
    expect(subscriptionSituation([team, pro]).record?.tier).toBe("team");
  });

  it("同档时取付到更晚的那一条", () => {
    const early = row({
      stripeSubscriptionId: "sub_a",
      currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
    });
    const late = row({
      stripeSubscriptionId: "sub_b",
      currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    expect(subscriptionSituation([early, late]).record?.stripeSubscriptionId).toBe("sub_b");
    expect(subscriptionSituation([late, early]).record?.stripeSubscriptionId).toBe("sub_b");
  });

  it("档位和周期都一样时仍然只有一个答案", () => {
    // 两条完全等价，谁生效都行 —— 要紧的是同一批行每次读出来的是同一条，
    // 不会随着调用方给的顺序变。
    const a = row({ stripeSubscriptionId: "sub_a" });
    const b = row({ stripeSubscriptionId: "sub_b" });
    const one = subscriptionSituation([a, b]).record?.stripeSubscriptionId;
    const other = subscriptionSituation([b, a]).record?.stripeSubscriptionId;
    expect(one).toBe(other);
  });

  it("已终结的那条不参与挑选", () => {
    const dead = row({
      stripeSubscriptionId: "sub_dead",
      tier: "team",
      status: "canceled",
    });
    expect(subscriptionSituation([dead, pro]).record?.stripeSubscriptionId).toBe("sub_pro");
  });

  it("不改动调用方传进来的那个数组", () => {
    const rows = [pro, team];
    subscriptionSituation(rows);
    expect(rows[0]?.stripeSubscriptionId).toBe("sub_pro");
  });
});

describe("subscriptionSituation — 没付成的那条不能压过正在生效的", () => {
  // 一条 incomplete 的订阅还没买到任何东西（tierForSituation 对它返回 base）。
  // 只按档位排的话，一条没付成的 team 会压过正在生效的 pro，账号当场掉到
  // base —— 用户付着 PRO 的钱、拿的是免费档的额度。

  const activePro = row({
    stripeSubscriptionId: "sub_active_pro",
    status: "active",
    tier: "pro",
    currentPeriodEnd: new Date("2026-09-18T00:00:00Z"),
  });

  it("正在生效的 pro 压过没付成的 team", () => {
    const unpaidTeam = row({
      stripeSubscriptionId: "sub_unpaid_team",
      status: "incomplete",
      tier: "team",
      currentPeriodEnd: null,
    });

    for (const rows of [[activePro, unpaidTeam], [unpaidTeam, activePro]]) {
      const reading = subscriptionSituation(rows);
      expect(reading.record?.stripeSubscriptionId).toBe("sub_active_pro");
      expect(reading.situation).toBe("active");
      expect(tierForSituation(reading.situation, reading.record)).toBe("pro");
    }
  });

  it("扣款重试中的也压过没付成的：那一档还在给他用", () => {
    const retryingPro = row({
      stripeSubscriptionId: "sub_retrying",
      status: "past_due",
      tier: "pro",
    });
    const unpaidTeam = row({
      stripeSubscriptionId: "sub_unpaid_team",
      status: "incomplete",
      tier: "team",
      currentPeriodEnd: null,
    });

    const reading = subscriptionSituation([unpaidTeam, retryingPro]);
    expect(reading.situation).toBe("retrying");
    expect(tierForSituation(reading.situation, reading.record)).toBe("pro");
  });

  it("只有没付成的那条时，照常报首付未成", () => {
    const unpaid = row({
      stripeSubscriptionId: "sub_only_unpaid",
      status: "incomplete",
      currentPeriodEnd: null,
    });
    expect(subscriptionSituation([unpaid]).situation).toBe(
      "firstPaymentUnsettled",
    );
  });
});
