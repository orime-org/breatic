// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Confirming a membership checkout when the buyer comes back (#307 §5.4) —
 * real PG, Stripe double.
 *
 * Stripe sends the buyer home the moment the payment is submitted, which is
 * often before the webhook that records it. The return asks Stripe about that
 * one Checkout Session and stores what it says, so the buyer sees the tier
 * they paid for straight away; the webhook still arrives and finds the work
 * done.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject, vi } from "vitest";

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

const stripe = {
  checkout: { sessions: { retrieve: vi.fn() } },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: vi.fn(),
}));

import postgres from "postgres";
import {
  initCore,
  loadLocales,
  getSubscriptionPlan,
  getUserMembershipTier,
} from "@breatic/core";
import { confirmCheckout } from "@server/modules/subscription/subscription.service.js";

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
    connection: { application_name: "subscription-confirm-test" },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

/**
 * A price object as Stripe expands it, built from the list we sell.
 * @param tier - Which tier this price sells.
 * @returns The price, expanded.
 */
function proMonthly(tier: "pro" | "team" = "pro"): unknown {
  const plan = getSubscriptionPlan(tier, "month");
  return {
    id: plan.stripePriceId,
    unit_amount: plan.priceCents,
    currency: plan.currency,
    recurring: { interval: "month" },
  };
}

/**
 * Creates an account known to Stripe.
 * @returns Its id and Stripe customer id.
 */
async function makeAccount(): Promise<{ userId: string; customerId: string }> {
  seq += 1;
  const customerId = `cus_confirm_${Date.now()}_${seq}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, stripe_customer_id)
    VALUES (${`sub-confirm-${Date.now()}-${seq}@example.test`}, true, ${customerId})
    RETURNING id
  `;
  return { userId: row!.id, customerId };
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

/**
 * A Checkout Session as Stripe returns it with the subscription expanded.
 * @param userId - Whose checkout it was.
 * @param customerId - The Stripe customer.
 * @param over - The fields one case cares about.
 * @returns A session object.
 */
function session(
  userId: string,
  customerId: string,
  over: Record<string, unknown> = {},
): unknown {
  return {
    id: `cs_${seq}`,
    mode: "subscription",
    client_reference_id: userId,
    subscription: {
      id: `sub_confirm_${seq}`,
      customer: customerId,
      status: "active",
      cancel_at_period_end: false,
      pending_update: null,
      latest_invoice: null,
      items: { data: [{ id: "si_1", current_period_end: PERIOD_END, price: proMonthly() }] },
      metadata: { userId },
    },
    ...over,
  };
}

/**
 * Counts the subscription rows stored for an account.
 * @param userId - The account.
 * @returns How many there are.
 */
async function storedRows(userId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM subscriptions WHERE user_id = ${userId}
  `;
  return Number(row?.count ?? 0);
}

describe("confirmCheckout (#307 A5–A8)", () => {
  it("stores the paid subscription and settles the tier before any webhook (A5)", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValueOnce(session(userId, customerId));

      await confirmCheckout(userId, `cs_${seq}`);

      expect(await getUserMembershipTier(userId)).toBe("pro");
      expect(await storedRows(userId)).toBe(1);
      const [, params, options] = stripe.checkout.sessions.retrieve.mock.calls[0] as [
        string,
        { expand?: string[] },
        { timeout?: number; maxNetworkRetries?: number },
      ];
      expect(params.expand).toEqual(["subscription.latest_invoice"]);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.maxNetworkRetries).toBe(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("stamps the snapshot with the moment Stripe was asked, not when it answered (A8)", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      let answeredAt = 0;
      stripe.checkout.sessions.retrieve.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        answeredAt = Date.now();
        return session(userId, customerId);
      });

      await confirmCheckout(userId, `cs_${seq}`);

      const [row] = await sql<{ observed_at: Date }[]>`
        SELECT observed_at FROM subscriptions WHERE user_id = ${userId}
      `;
      expect(row!.observed_at.getTime()).toBeLessThan(answeredAt);
    } finally {
      await dropUser(userId);
    }
  });

  it("refuses somebody else's checkout and writes nothing (A7)", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValueOnce(
        session("someone-else", customerId),
      );

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ status: 404 });
      expect(await storedRows(userId)).toBe(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("refuses a credits checkout (A7)", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValueOnce(
        session(userId, customerId, { mode: "payment", subscription: null }),
      );

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ status: 404 });
      expect(await storedRows(userId)).toBe(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("refuses a checkout id Stripe does not know (A7)", async () => {
    const { userId } = await makeAccount();
    try {
      stripe.checkout.sessions.retrieve.mockRejectedValueOnce(
        Object.assign(new Error("No such checkout.session"), { code: "resource_missing" }),
      );

      await expect(confirmCheckout(userId, "cs_unknown")).rejects.toMatchObject({ status: 404 });
    } finally {
      await dropUser(userId);
    }
  });

  it("answers 503 when the session carries no subscription yet (A6)", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      stripe.checkout.sessions.retrieve.mockResolvedValueOnce(
        session(userId, customerId, { subscription: null }),
      );

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ status: 503 });
      expect(await storedRows(userId)).toBe(0);
    } finally {
      await dropUser(userId);
    }
  });

  it("answers 503 and writes nothing when the price disagrees with ours (A6)", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      const odd = session(userId, customerId) as { subscription: { items: { data: { price: { unit_amount: number } }[] } } };
      odd.subscription.items.data[0]!.price.unit_amount += 1;
      stripe.checkout.sessions.retrieve.mockResolvedValueOnce(odd);

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ status: 503 });
      expect(await storedRows(userId)).toBe(0);
      expect(await getUserMembershipTier(userId)).toBe("base");
    } finally {
      await dropUser(userId);
    }
  });

  it("lets a Stripe outage through for the route to answer (A6)", async () => {
    const { userId } = await makeAccount();
    try {
      stripe.checkout.sessions.retrieve.mockRejectedValueOnce(new Error("Stripe is unreachable"));

      await expect(confirmCheckout(userId, "cs_down")).rejects.toThrow("Stripe is unreachable");
    } finally {
      await dropUser(userId);
    }
  });
});
