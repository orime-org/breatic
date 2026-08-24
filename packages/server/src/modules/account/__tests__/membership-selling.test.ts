// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 一个部署卖不卖订阅，决定会员面板的两件事（#106 验收 6）。
 *
 * 自部署不接 Stripe，所以那边既没有价格可报，也没有订阅可描述。这两个分支
 * 此前在服务端一个测试都没有：改坏了不会红，而验收第 6 条要的正是「自部署
 * 路径完全不受影响」。
 *
 * 价格必须是 null 而不是 0 —— PRO 在有卖的地方是 12 美元，在这里说它免费
 * 是在描述一家不存在的店。前端据此把这一格画成「—」，跟免费档的「免费」
 * 是两回事。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { envRef } = vi.hoisted(() => ({ envRef: { PAYMENT_ENABLED: true } }));

vi.mock("@breatic/core", () => ({
  env: envRef,
  getUserMembershipTier: vi.fn(),
  getLimitsForUser: vi.fn(),
  getSubscriptionPlan: (tier: string) => ({
    priceCents: tier === "pro" ? 1200 : 3900,
    currency: "usd",
  }),
  getMembershipLimits: () => LIMITS,
  COMPARABLE_MEMBERSHIP_TIERS: ["base", "pro", "team"],
}));

vi.mock("@server/modules/subscription/subscription-panel.js", () => ({
  readSubscriptionSummary: vi.fn(),
}));

vi.mock("@server/modules/asset/assetUsage.service.js", () => ({
  accountStorageUsage: vi.fn(),
}));

vi.mock("@server/modules/studio/studio.repo.js", () => ({
  countTeamStudiosAdministeredBy: vi.fn(),
}));

import {
  getUserMembershipTier,
  getLimitsForUser,
} from "@breatic/core";
import { readSubscriptionSummary } from "@server/modules/subscription/subscription-panel.js";
import * as assetUsageService from "@server/modules/asset/assetUsage.service.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";

const LIMITS = {
  team_studios: 1,
  projects_per_studio: 100,
  concurrent_editors: 6,
  studio_members: 10,
  project_members: 12,
  storage_bytes: 200 * 1024 ** 3,
};

const USER = "u-1";

beforeEach(() => {
  vi.clearAllMocks();
  envRef.PAYMENT_ENABLED = true;
  vi.mocked(getUserMembershipTier).mockResolvedValue("pro");
  vi.mocked(getLimitsForUser).mockResolvedValue(LIMITS);
  vi.mocked(readSubscriptionSummary).mockResolvedValue({
    state: "active",
    tier: "pro",
    currentPeriodEnd: "2026-09-18T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    payableInvoiceUrl: null,
  });
  vi.mocked(studioRepo.countTeamStudiosAdministeredBy).mockResolvedValue(1);
  vi.mocked(assetUsageService.accountStorageUsage).mockResolvedValue(0);
});

describe("readAccountMembership — 这个部署卖东西时", () => {
  it("有价格的档位报价格，免费档不报", async () => {
    const result = await readAccountMembership(USER);

    expect(result.catalog.map((offer) => offer.priceCents)).toEqual([
      null,
      1200,
      3900,
    ]);
    expect(result.subscription).not.toBeNull();
  });
});

describe("readAccountMembership — 这个部署不卖东西时（验收 6）", () => {
  beforeEach(() => {
    envRef.PAYMENT_ENABLED = false;
  });

  it("三档价格全空，而不是零", async () => {
    const result = await readAccountMembership(USER);

    expect(result.catalog.map((offer) => offer.priceCents)).toEqual([
      null,
      null,
      null,
    ]);
    expect(result.catalog.map((offer) => offer.currency)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("没有订阅那一段，而且压根不去问 Stripe", async () => {
    const result = await readAccountMembership(USER);

    expect(result.subscription).toBeNull();
    expect(readSubscriptionSummary).not.toHaveBeenCalled();
  });

  it("档位和额度照常，不受影响", async () => {
    const result = await readAccountMembership(USER);

    expect(result.tier).toBe("pro");
    expect(result.limits).toEqual(LIMITS);
  });
});
