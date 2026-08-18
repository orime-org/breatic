// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
}));

vi.mock("@server/modules/notification/notification.service.js", () => ({
  createMembershipEnded: vi.fn(),
}));

import { changeMembershipTier } from "@breatic/core";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { settleTier } from "@server/modules/subscription/settle-tier.js";

const USER = "u-1";

beforeEach(() => {
  vi.clearAllMocks();
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
      reason: "subscription_ended",
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
      reason: "subscription_ended",
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
      reason: "subscription_activated",
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
      reason: "subscription_activated",
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
      reason: "subscription_ended",
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
