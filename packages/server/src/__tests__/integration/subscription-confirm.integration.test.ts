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
  subscriptions: { retrieve: vi.fn() },
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
import type Stripe from "stripe";
import { confirmCheckout } from "@server/modules/subscription/subscription.service.js";
import { handleSubscriptionEvent } from "@server/modules/subscription/subscription-events.js";

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

const eventIds: string[] = [];

afterAll(async () => {
  if (eventIds.length > 0) {
    await sql`DELETE FROM stripe_webhook_events WHERE event_id IN ${sql(eventIds)}`;
  }
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

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ statusCode: 404 });
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

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ statusCode: 404 });
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

      await expect(confirmCheckout(userId, "cs_unknown")).rejects.toMatchObject({ statusCode: 404 });
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

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ statusCode: 503 });
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

      await expect(confirmCheckout(userId, `cs_${seq}`)).rejects.toMatchObject({ statusCode: 503 });
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

describe("confirmCheckout and the webhook arriving in either order (#307 A8)", () => {
  /**
   * The subscription as Stripe describes it at one moment.
   * @param userId - Whose it is.
   * @param customerId - The Stripe customer.
   * @param tier - Which tier its price sells.
   * @returns A subscription object.
   */
  function subscriptionOn(
    userId: string,
    customerId: string,
    tier: "pro" | "team",
  ): Record<string, unknown> {
    return {
      id: `sub_confirm_${seq}`,
      customer: customerId,
      status: "active",
      cancel_at_period_end: false,
      pending_update: null,
      latest_invoice: null,
      items: { data: [{ id: "si_1", current_period_end: PERIOD_END, price: proMonthly(tier) }] },
      metadata: { userId },
    };
  }

  /**
   * A promise and the function that settles it, so one call can be held open.
   * @returns The promise and its resolver.
   */
  function held<T>(): { promise: Promise<T>; release: (value: T) => void } {
    let release!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  /**
   * A webhook event naming the subscription.
   * @param subscription - The subscription the event carries.
   * @returns A Stripe event.
   */
  function updated(subscription: Record<string, unknown>): Stripe.Event {
    const id = `evt_confirm_${seq}_${Date.now()}`;
    eventIds.push(id);
    return {
      id,
      type: "customer.subscription.updated",
      data: { object: subscription },
    } as unknown as Stripe.Event;
  }

  it("keeps the webhook's newer answer when the confirm that asked first commits last", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      const stale = held<unknown>();
      stripe.checkout.sessions.retrieve.mockReturnValueOnce(stale.promise);
      const confirming = confirmCheckout(userId, `cs_${seq}`);
      await new Promise((resolve) => setTimeout(resolve, 20));

      stripe.subscriptions.retrieve.mockResolvedValueOnce(subscriptionOn(userId, customerId, "team"));
      await handleSubscriptionEvent(updated(subscriptionOn(userId, customerId, "team")));

      stale.release(session(userId, customerId));
      await confirming;

      expect(await getUserMembershipTier(userId)).toBe("team");
      expect(await storedRows(userId)).toBe(1);
    } finally {
      await dropUser(userId);
    }
  });

  it("keeps the confirm's newer answer when the webhook that asked first commits last", async () => {
    const { userId, customerId } = await makeAccount();
    try {
      const stale = held<unknown>();
      stripe.subscriptions.retrieve.mockReturnValueOnce(stale.promise);
      const webhook = handleSubscriptionEvent(updated(subscriptionOn(userId, customerId, "team")));
      await new Promise((resolve) => setTimeout(resolve, 20));

      stripe.checkout.sessions.retrieve.mockResolvedValueOnce(session(userId, customerId));
      await confirmCheckout(userId, `cs_${seq}`);

      stale.release(subscriptionOn(userId, customerId, "team"));
      await webhook;

      expect(await getUserMembershipTier(userId)).toBe("pro");
      expect(await storedRows(userId)).toBe(1);
    } finally {
      await dropUser(userId);
    }
  });
});
