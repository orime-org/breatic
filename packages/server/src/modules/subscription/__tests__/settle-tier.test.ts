// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 档位落地的唯一出口（#106 §9）。
 *
 * 「掉回免费档要通知用户」这件事挂在**结果**上，不挂在事件类型上：`unpaid` 和
 * `incomplete_expired` 走的是 `customer.subscription.updated`，压根不产生
 * `deleted`，而对账那条路一个 Stripe 事件都没有。挂事件类型的话，四条回落路径
 * 只有一条会通知。
 *
 * 铃铛是保底通道、邮件是可选增强（`notification-mail.ts` 文件头的契约，
 * `EMAIL_BACKEND` 默认就是 `disabled`），所以两个都要有，且铃铛在事务里。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@breatic/core", () => ({
  changeMembershipTier: vi.fn(),
  getUserMembershipTier: vi.fn(),
}));

vi.mock("@server/modules/notification/notification.service.js", () => ({
  createMembershipEnded: vi.fn(),
}));

import { changeMembershipTier, getUserMembershipTier } from "@breatic/core";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { settleTier } from "@server/modules/subscription/settle-tier.js";

const USER = "u-1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserMembershipTier).mockResolvedValue("pro");
});

describe("settleTier — 订阅只管它自己给出的那些档位", () => {
  it.each(["enterprise", "self_hosted"] as const)(
    "不碰 %s：那不是订阅给的",
    async (stored) => {
      // 一个谈下来的企业账号、或者部署形态就是自部署的账号，只要它在 Stripe
      // 那边有过一次 customer（点过一次订阅按钮就有），打开会员面板就会走到
      // 对账。对账问 Stripe「有活订阅吗」，答案是没有，于是这里被要求写
      // base —— 而那个档位根本不是订阅给的，订阅无权收回。
      vi.mocked(getUserMembershipTier).mockResolvedValue(stored);

      const result = await settleTier({
        userId: USER,
        toTier: "base",
        referenceId: "reconcile:cus_1",
      });

      expect(changeMembershipTier).not.toHaveBeenCalled();
      expect(notificationService.createMembershipEnded).not.toHaveBeenCalled();
      expect(result).toEqual({
        changed: false,
        fromTier: stored,
        endedFrom: null,
      });
    },
  );

  it.each(["base", "pro", "team"] as const)(
    "照常改写 %s：这些就是订阅给的",
    async (stored) => {
      vi.mocked(getUserMembershipTier).mockResolvedValue(stored);
      vi.mocked(changeMembershipTier).mockResolvedValueOnce({
        changed: true,
        fromTier: stored,
      });

      await settleTier({
        userId: USER,
        toTier: "team",
      });

      expect(changeMembershipTier).toHaveBeenCalled();
    },
  );
});

describe("settleTier — 账本记的原因由落点决定", () => {
  // 这个判断此前在两个调用方各写一遍，而两遍问的不是同一个问题：webhook 问
  // 档位是不是 base，对账问处境是不是 none —— 对「唯一那条活订阅还没付成」
  // 的账号，两者答案相反。收回来一处算之后，两半都要有人钉着。

  it.each([
    ["base", "subscription_ended"],
    ["pro", "subscription_activated"],
    ["team", "subscription_activated"],
  ] as const)("落到 %s 记 %s", async (toTier, expected) => {
    vi.mocked(changeMembershipTier).mockResolvedValueOnce({
      changed: true,
      fromTier: toTier === "base" ? "pro" : "base",
    });

    await settleTier({ userId: USER, toTier });

    expect(changeMembershipTier).toHaveBeenCalledWith(
      USER,
      toTier,
      expected,
      undefined,
      undefined,
    );
  });
});

describe("settleTier (#106 §9)", () => {
  it("rings the bell when a paid tier falls back to base", async () => {
    vi.mocked(changeMembershipTier).mockResolvedValueOnce({
      changed: true,
      fromTier: "pro",
    });

    const result = await settleTier({
      userId: USER,
      toTier: "base",
      referenceId: "evt_1",
    });

    expect(notificationService.createMembershipEnded).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, payload: { fromTier: "pro" } }),
    );
    // The caller sends the mail after its transaction commits; this says one
    // is owed and which tier ended.
    expect(result.endedFrom).toBe("pro");
  });

  it("stays quiet when the tier did not move", async () => {
    // A redelivered event that changes nothing must not tell somebody their
    // membership ended for a second time.
    vi.mocked(changeMembershipTier).mockResolvedValueOnce({
      changed: false,
      fromTier: "base",
    });

    const result = await settleTier({
      userId: USER,
      toTier: "base",
    });

    expect(notificationService.createMembershipEnded).not.toHaveBeenCalled();
    expect(result.endedFrom).toBeNull();
  });

  it("stays quiet when the account moves up rather than down", async () => {
    vi.mocked(changeMembershipTier).mockResolvedValueOnce({
      changed: true,
      fromTier: "base",
    });

    const result = await settleTier({
      userId: USER,
      toTier: "pro",
    });

    expect(notificationService.createMembershipEnded).not.toHaveBeenCalled();
    expect(result.endedFrom).toBeNull();
  });

  it("stays quiet when a downgrade lands on another paid tier", async () => {
    // Nothing has ended here; the account still has a membership.
    vi.mocked(changeMembershipTier).mockResolvedValueOnce({
      changed: true,
      fromTier: "team",
    });

    const result = await settleTier({
      userId: USER,
      toTier: "pro",
    });

    expect(notificationService.createMembershipEnded).not.toHaveBeenCalled();
    expect(result.endedFrom).toBeNull();
  });

  it("passes the transaction through, so the bell shares the tier change's fate", async () => {
    const tx = { marker: "tx" } as never;
    vi.mocked(changeMembershipTier).mockResolvedValueOnce({
      changed: true,
      fromTier: "team",
    });

    await settleTier({
      userId: USER,
      toTier: "base",
      tx,
    });

    expect(changeMembershipTier).toHaveBeenCalledWith(
      USER,
      "base",
      "subscription_ended",
      undefined,
      tx,
    );
    expect(notificationService.createMembershipEnded).toHaveBeenCalledWith(
      expect.objectContaining({ tx }),
    );
  });
});
