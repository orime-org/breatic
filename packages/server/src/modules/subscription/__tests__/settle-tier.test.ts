// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one door a subscription's tier goes through (#106 §9).
 *
 * The "you are back on the free tier" notice hangs on the RESULT, not on an
 * event type: `unpaid` and `incomplete_expired` arrive as
 * `customer.subscription.updated` and produce no `deleted`, and the paths that
 * store Stripe's answer to our own calls produce no Stripe event at all.
 * Hanging it on an event type would notify only some of them.
 *
 * The bell is the channel that always arrives and the email is optional (the
 * contract at the top of `notification-mail.ts`; `EMAIL_BACKEND` defaults to
 * `disabled`), so both are sent and the bell is written in the transaction.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@breatic/core", () => ({
  changeMembershipTier: vi.fn(),
  getUserMembershipTier: vi.fn(),
}));

// The mail goes on the worker's queue; this suite reads the tier and the bell.
vi.mock("@breatic/domain", () => ({ enqueueMail: vi.fn() }));

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
      // A negotiated enterprise account, or one whose deployment is
      // self-hosted, was not given its tier by a subscription, so a
      // subscription write asking for `base` must not take it away.
      vi.mocked(getUserMembershipTier).mockResolvedValue(stored);

      const result = await settleTier({
        userId: USER,
        toTier: "base",
        referenceId: "checkout:cs_1",
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
  // The reason follows from where the tier lands, worked out in one place;
  // both halves of that rule are pinned here.

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
