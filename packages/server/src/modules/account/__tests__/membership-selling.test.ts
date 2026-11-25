// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whether a deployment sells memberships decides two things on the panel
 * (#106 acceptance 6, inner#1993 §3.2 #17): where a billing service is
 * configured, the prices and the outstanding invoice come from it; where none
 * is, there are no prices and no subscription to describe.
 *
 * A price is null rather than 0 where none is quoted: saying PRO is free on a
 * deployment that does not sell it describes a shop that does not exist. The
 * page draws such a cell as "—", apart from the free tier's "Free".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Core from "@breatic/core";

const { envRef } = vi.hoisted(() => ({ envRef: { SELLING: true } }));

vi.mock("@breatic/core", async (original) => ({
  membershipPanelAnswerSchema: (await original<typeof Core>()).membershipPanelAnswerSchema,
  env: envRef,
  logger: { error: vi.fn() },
  getCommerceConfig: () => ({ catalog_cache_seconds: 300 }),
  getMembershipForUser: vi.fn(),
  getMembershipLimits: () => LIMITS,
}));

vi.mock("@server/modules/commerce/commerce-client.js", () => ({
  requestCommerce: vi.fn(),
  userPath: (userId: string, sub: string) => `/users/${userId}${sub}`,
}));

vi.mock("@server/modules/account/subscription-panel.js", () => ({
  readStoredSubscriptionSummary: vi.fn(),
}));

vi.mock("@server/modules/asset/assetUsage.service.js", () => ({
  accountStorageUsage: vi.fn(),
}));

vi.mock("@server/modules/studio/studio.repo.js", () => ({
  countTeamStudiosAdministeredBy: vi.fn(),
}));

import { getMembershipForUser } from "@breatic/core";
import { requestCommerce } from "@server/modules/commerce/commerce-client.js";
import { readStoredSubscriptionSummary } from "@server/modules/account/subscription-panel.js";
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
  running_tasks_per_user: 5,
};

const USER = "u-1";
const PRICES = {
  pro: { month: { priceCents: 1999, currency: "usd" }, year: { priceCents: 19990, currency: "usd" } },
  team: { month: { priceCents: 7999, currency: "usd" }, year: { priceCents: 79990, currency: "usd" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  envRef.SELLING = true;
  vi.mocked(getMembershipForUser).mockResolvedValue({ tier: "pro", limits: LIMITS, storageLimitBytes: LIMITS.storage_bytes });
  vi.mocked(readStoredSubscriptionSummary).mockResolvedValue({
    state: "active",
    tier: "pro",
    period: "month",
    currentPeriodEnd: "2026-09-18T00:00:00.000Z",
    cancelAtPeriodEnd: false,
  });
  vi.mocked(requestCommerce).mockResolvedValue({ data: { prices: PRICES, payableInvoiceUrl: "https://invoice.example/1" } });
  vi.mocked(studioRepo.countTeamStudiosAdministeredBy).mockResolvedValue(1);
  vi.mocked(assetUsageService.accountStorageUsage).mockResolvedValue(0);
});

describe("readAccountMembership where the deployment sells", () => {
  it("quotes the billing service's price per period for the priced tiers and neither for the free one", async () => {
    const result = await readAccountMembership(USER);

    expect(result.catalog.map((offer) => offer.prices)).toEqual([{ month: null, year: null }, PRICES.pro, PRICES.team]);
  });

  it("describes the stored subscription with the billing service's outstanding invoice", async () => {
    const result = await readAccountMembership(USER);

    expect(result.subscription).toMatchObject({ state: "active", payableInvoiceUrl: "https://invoice.example/1" });
  });
});

describe("readAccountMembership where the deployment sells nothing (acceptance 6)", () => {
  beforeEach(() => {
    envRef.SELLING = false;
  });

  it("leaves all three tiers empty over both periods rather than zero", async () => {
    const result = await readAccountMembership(USER);

    expect(result.catalog.map((offer) => offer.prices)).toEqual([
      { month: null, year: null },
      { month: null, year: null },
      { month: null, year: null },
    ]);
  });

  it("has no subscription section and asks nobody", async () => {
    const result = await readAccountMembership(USER);

    expect(result.subscription).toBeNull();
    expect(readStoredSubscriptionSummary).not.toHaveBeenCalled();
    expect(requestCommerce).not.toHaveBeenCalled();
  });

  it("still answers the tier and its limits", async () => {
    const result = await readAccountMembership(USER);

    expect(result.tier).toBe("pro");
    expect(result.limits).toEqual(LIMITS);
  });
});
