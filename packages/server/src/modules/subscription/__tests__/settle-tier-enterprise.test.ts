// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@breatic/core", () => ({ changeMembershipTier: vi.fn(), getUserMembershipTier: vi.fn(), getMembershipReadingForUser: vi.fn() }));
vi.mock("@breatic/domain", () => ({ enqueueMail: vi.fn() }));
vi.mock("@server/modules/notification/notification.service.js", () => ({ createMembershipEnded: vi.fn() }));

import { changeMembershipTier, getUserMembershipTier, getMembershipReadingForUser } from "@breatic/core";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { settleTier } from "../settle-tier.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserMembershipTier).mockResolvedValue("enterprise");
  vi.mocked(changeMembershipTier).mockResolvedValue({ changed: true, fromTier: "enterprise" });
});

describe("enterprise source-aware subscription tier settlement", () => {
  it("normalizes an expired SaaS enterprise tier without a paid-membership ending notice", async () => {
    vi.mocked(getMembershipReadingForUser).mockResolvedValue({ storedTier: "enterprise", settlementProtected: false } as never);
    const tx = { test: "transaction" } as never;
    const result = await settleTier({ userId: "account", toTier: "base", referenceId: "subscription", tx });
    expect(changeMembershipTier).toHaveBeenCalledWith("account", "base", "subscription_ended", "subscription", tx);
    expect(notificationService.createMembershipEnded).not.toHaveBeenCalled();
    expect(result).toEqual({ changed: true, fromTier: "enterprise", endedFrom: null });
  });
  it.each(["active", "missing", "expired-self-hosted"])("preserves source protection for %s", async () => {
    vi.mocked(getMembershipReadingForUser).mockResolvedValue({ storedTier: "enterprise", settlementProtected: true } as never);
    expect(await settleTier({ userId: "account", toTier: "base" })).toEqual({ changed: false, fromTier: "enterprise", endedFrom: null });
    expect(changeMembershipTier).not.toHaveBeenCalled();
  });
});
