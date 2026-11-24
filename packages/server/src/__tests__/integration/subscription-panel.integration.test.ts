// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the membership panel is told, read from our own data (#106 §11, #307) —
 * real PG.
 *
 * The subscription comes from the product's own projection. A subscription still marked live but
 * past its deadline reads as ended in every part of the answer: the tier, the
 * ceilings and the subscription lines.
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

import postgres from "postgres";
import {
  env,
  initCore,
  loadLocales,
  getMembershipLimits,
  getSubscriptionStaleAfterDays,
  db,
  upsertSubscription,
} from "@breatic/core";
import type { StripeSubscriptionStatus } from "@breatic/core";
import { readStoredSubscriptionSummary } from "@server/modules/account/subscription-panel.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  // Some assertions need the deployment to sell; set here rather than at
  // module load, so this call lands after every other suite's initCore.
  initCore({
    ...process.env,
    // A billing service nobody answers on: the panel quotes no prices, and
    // the subscription is read from the product's own projection regardless.
    CHARGING_ENABLED: "true",
    INTERNAL_API_ENABLED: "true",
    INTERNAL_API_SECRET: "internal-secret-current-0123456789abcdef",
    COMMERCE_API_URL: "http://127.0.0.1:9",
    COMMERCE_API_SECRET: "commerce-secret-current-0123456789abcdef",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "subscription-panel-test" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  // 还回去，免得这个 flag 漏给后面跑的套件。
  initCore(process.env);
  await sql?.end({ timeout: 1 });
});

const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

/**
 * Creates an account.
 * @param tier - The tier its row carries.
 * @param customerId - Its Stripe customer, or null for one that never paid.
 * @returns Its id.
 */
async function makeUser(
  tier: string,
  customerId: string | null,
): Promise<string> {
  seq += 1;
  const email = `sub-panel-${Date.now()}-${seq}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier, stripe_customer_id)
    VALUES (${email}, true, ${tier}, ${customerId})
    RETURNING id
  `;
  return row!.id;
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stores a subscription row the way the webhook would.
 * @param userId - Whose subscription it is.
 * @param over - The fields one case cares about.
 */
async function storeRow(
  userId: string,
  over: {
    status?: StripeSubscriptionStatus;
    currentPeriodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
    payableInvoiceUrl?: string | null;
  } = {},
): Promise<void> {
  seq += 1;
  await upsertSubscription(db, {
    userId,
    stripeSubscriptionId: `sub_panel_row_${Date.now()}_${seq}`,
    tier: "pro",
    period: "month",
    status: over.status ?? "active",
    currentPeriodEnd: over.currentPeriodEnd ?? new Date(PERIOD_END * 1000),
    cancelAtPeriodEnd: over.cancelAtPeriodEnd ?? false,
    stripeItemId: "si_1",
    hasPendingUpdate: false,
    pendingTier: null,
    pendingPeriod: null,
    payableInvoiceUrl: over.payableInvoiceUrl ?? null,
    observedAt: new Date(),
  });
}

describe("readStoredSubscriptionSummary — an account that never paid (#106 §11)", () => {
  it("says it has no subscription, rather than saying nothing", async () => {
    // Null means "this deployment sells no subscriptions" and nothing else.
    // An account that simply has not bought one is in the state the offers
    // exist for, and answering null there is what took the buttons away from
    // exactly the people who need them.
    const userId = await makeUser("base", null);
    try {
      const summary = await readStoredSubscriptionSummary(userId);
      expect(summary.state).toBe("none");
      expect(summary.tier).toBe("base");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("readStoredSubscriptionSummary — what the panel is told (#106 §11)", () => {
  it("gives the situation rather than Stripe's raw status", async () => {
    // `active` alone cannot tell "running", "ending" and "upgrade unpaid"
    // apart, and the panel shows something different for each.
    const userId = await makeUser("pro", `cus_panel_e_${Date.now()}`);
    try {
      await storeRow(userId, { cancelAtPeriodEnd: true });

      const summary = await readStoredSubscriptionSummary(userId);

      expect(summary.state).toBe("cancelling");
      expect(summary.cancelAtPeriodEnd).toBe(true);
      expect(summary.currentPeriodEnd).toBe(new Date(PERIOD_END * 1000).toISOString());
    } finally {
      await dropUser(userId);
    }
  });

  it("reads a charge being retried as retrying and leaves the payment link to the billing service", async () => {
    // The link a stored row still holds may be stale; the billing service's
    // panel answer quotes the current one (membership.service.ts).
    const userId = await makeUser("pro", `cus_panel_f_${Date.now()}`);
    try {
      await storeRow(userId, {
        status: "past_due",
        payableInvoiceUrl: "https://invoice.example/pay",
      });

      const summary = await readStoredSubscriptionSummary(userId);

      expect(summary.state).toBe("retrying");
      expect(summary).not.toHaveProperty("payableInvoiceUrl");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("readAccountMembership — answered from our own data (#307)", () => {
  it("answers the subscription from the stored projection (A1)", async () => {
    // Precondition: without the flag the selling branch is not exercised and
    // every assertion below would pass for the wrong reason.
    expect(env.SELLING, "this suite needs a billing service configured").toBe(true);
    const userId = await makeUser("pro", `cus_local_${Date.now()}`);
    try {
      await storeRow(userId);

      const membership = await readAccountMembership(userId);

      expect(membership.tier).toBe("pro");
      expect(membership.subscription?.state).toBe("active");
      expect(membership.limits).toEqual(getMembershipLimits("pro"));
    } finally {
      await dropUser(userId);
    }
  });

  it("reads a subscription nobody heard from past its window as ended, everywhere (A2)", async () => {
    expect(env.SELLING, "this suite needs a billing service configured").toBe(true);
    const userId = await makeUser("pro", `cus_lapsed_${Date.now()}`);
    try {
      await storeRow(userId, {
        currentPeriodEnd: new Date(
          Date.now() - (getSubscriptionStaleAfterDays() + 1) * DAY_MS,
        ),
      });

      const membership = await readAccountMembership(userId);

      expect(membership.tier).toBe("base");
      expect(membership.limits).toEqual(getMembershipLimits("base"));
      expect(membership.subscription?.state).toBe("none");
      expect(membership.subscription?.tier).toBe("base");
      expect(membership.subscription?.period).toBeNull();
    } finally {
      await dropUser(userId);
    }
  });

  it("reads a cancelling subscription as ended right after its period end (A3)", async () => {
    expect(env.SELLING, "this suite needs a billing service configured").toBe(true);
    const userId = await makeUser("pro", `cus_cancelled_${Date.now()}`);
    try {
      await storeRow(userId, {
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() - 60_000),
      });

      const membership = await readAccountMembership(userId);

      expect(membership.tier).toBe("base");
      expect(membership.subscription?.state).toBe("none");
    } finally {
      await dropUser(userId);
    }
  });
});
