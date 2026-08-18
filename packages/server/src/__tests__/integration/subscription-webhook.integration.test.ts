// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Stripe 送来的订阅事件（#106 §8）—— 真 PG，Stripe 客户端替身。
 *
 * 这一层的三件事都只有真库能证：
 *
 * 一、**幂等靠主键**。同一个 event id 插第二次冲突，整个事务作废，所以档位不会
 * 变两次、账本不会多一行。比档位是不是「已经等于目标值」不管用——那种比较收敛
 * 到最后一次调用，分不出重放和新事件。
 *
 * 二、**乱序不看事件负载**。我们收到事件后回头问 Stripe 当前是什么样，所以先到
 * 的旧事件和后到的新事件问到的是同一个当前值，顺序不再重要。
 *
 * 三、**认人**。订阅事件上不带任何我们的标识，只有 customer；先建 customer 再
 * 结账就是为了这一步。
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

const stripe = {
  subscriptions: { retrieve: vi.fn() },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

import type Stripe from "stripe";
import postgres from "postgres";
import { initCore, loadLocales, getUserMembershipTier } from "@breatic/core";
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
    connection: { application_name: "subscription-webhook-test" },
  });
});

beforeEach(() => {
  // Call counts only: the double's implementations are set per case.
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

const PRO_PRICE = "price_1U5OqmGeRYMxofhepn2ij8zp";
const TEAM_PRICE = "price_1U5OrkGeRYMxofhepeUDWhqB";
const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

/**
 * Creates an account already known to Stripe.
 * @returns Its id and its Stripe customer id.
 */
async function makeCustomerAccount(): Promise<{
  userId: string;
  customerId: string;
}> {
  seq += 1;
  const email = `sub-hook-${Date.now()}-${seq}@example.test`;
  const customerId = `cus_hook_${Date.now()}_${seq}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, stripe_customer_id)
    VALUES (${email}, true, ${customerId})
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
 * A subscription as the Stripe SDK returns it.
 * @param over - The fields one case cares about.
 * @returns A subscription object.
 */
function stripeSub(over: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: `sub_hook_${seq}`,
    customer: "cus_x",
    status: "active",
    cancel_at_period_end: false,
    pending_update: null,
    latest_invoice: null,
    items: {
      data: [
        { id: "si_1", current_period_end: PERIOD_END, price: { id: PRO_PRICE } },
      ],
    },
    ...over,
  } as unknown as Stripe.Subscription;
}

/**
 * A webhook event carrying a subscription.
 * @param type - The event type.
 * @param subscription - The subscription it names.
 * @param id - The event id.
 * @returns A Stripe event.
 */
function event(
  type: string,
  subscription: Stripe.Subscription,
  id: string,
): Stripe.Event {
  return {
    id,
    type,
    data: { object: subscription },
  } as unknown as Stripe.Event;
}

describe("handleSubscriptionEvent — identifying the account (#106 §7.1)", () => {
  it("finds the account from the customer on the subscription", async () => {
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const sub = stripeSub({ id: `sub_id_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(sub);

      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.created", sub, `evt_id_${seq}`),
      );

      expect(outcome.status).toBe("applied");
      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });

  it("prefers the account id Stripe carried on the subscription itself", async () => {
    // The second identification line: metadata put there at checkout. It wins
    // because it is ours, where the customer is a join we maintain.
    const { userId } = await makeCustomerAccount();
    try {
      const sub = stripeSub({
        id: `sub_meta_${seq}`,
        customer: "cus_not_ours",
        metadata: { userId },
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(sub);

      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.created", sub, `evt_meta_${seq}`),
      );

      expect(outcome.status).toBe("applied");
      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });

  it("ignores an event whose customer belongs to nobody here", async () => {
    const sub = stripeSub({ id: `sub_alien_${seq}`, customer: "cus_alien" });
    const outcome = await handleSubscriptionEvent(
      event("customer.subscription.created", sub, `evt_alien_${Date.now()}`),
    );
    expect(outcome.status).toBe("ignored");
  });
});

describe("handleSubscriptionEvent — idempotency (#106 §8)", () => {
  it("applies a redelivered event exactly once", async () => {
    // Acceptance item 4. Comparing tiers cannot tell a replay from a new
    // event, so the guard is the event id's primary key.
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const sub = stripeSub({ id: `sub_dup_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValue(sub);
      const evt = event(
        "customer.subscription.created",
        sub,
        `evt_dup_${Date.now()}`,
      );

      const first = await handleSubscriptionEvent(evt);
      const second = await handleSubscriptionEvent(evt);

      expect(first.status).toBe("applied");
      expect(second.status).toBe("replay");
      const ledger = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM membership_tier_changes
        WHERE user_id = ${userId}
      `;
      expect(ledger[0]?.count).toBe("1");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — out of order (#106 §8)", () => {
  it("writes what Stripe says now, not what the late event carried", async () => {
    // An event that arrives after a newer one still asks for the current
    // state, so it cannot put the old status back.
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const current = stripeSub({
        id: `sub_ord_${seq}`,
        customer: customerId,
        status: "active",
        items: {
          data: [
            {
              id: "si_1",
              current_period_end: PERIOD_END,
              price: { id: TEAM_PRICE },
            },
          ],
        },
      });
      stripe.subscriptions.retrieve.mockResolvedValue(current);

      // The event payload is the OLD snapshot: pro, and merely incomplete.
      const stale = stripeSub({
        id: current.id,
        customer: customerId,
        status: "incomplete",
      });
      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.updated", stale, `evt_ord_${Date.now()}`),
      );

      expect(outcome.status).toBe("applied");
      expect(await getUserMembershipTier(userId)).toBe("team");
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM subscriptions WHERE user_id = ${userId}
      `;
      expect(row?.status).toBe("active");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — falling back to base (#106 §9)", () => {
  it("moves the account to base and rings the bell when the plan ends", async () => {
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const live = stripeSub({ id: `sub_end_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(live);
      await handleSubscriptionEvent(
        event("customer.subscription.created", live, `evt_end_a_${Date.now()}`),
      );
      expect(await getUserMembershipTier(userId)).toBe("pro");

      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: live.id, customer: customerId, status: "canceled" }),
      );
      await handleSubscriptionEvent(
        event("customer.subscription.deleted", live, `evt_end_b_${Date.now()}`),
      );

      expect(await getUserMembershipTier(userId)).toBe("base");
      const bells = await sql<{ type: string; payload: unknown }[]>`
        SELECT type, payload FROM notifications WHERE user_id = ${userId}
      `;
      expect(bells.map((b) => b.type)).toEqual(["membership.ended"]);
      expect(bells[0]?.payload).toEqual({ fromTier: "pro" });
    } finally {
      await dropUser(userId);
    }
  });

  it("keeps the paid tier while Stripe is still retrying the card", async () => {
    // Ratified 2026-08-18: `past_due` is the window in which Stripe collects
    // for us, and none of Notion, Figma or Slack downgrades on day one.
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const live = stripeSub({ id: `sub_due_${seq}`, customer: customerId });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(live);
      await handleSubscriptionEvent(
        event("customer.subscription.created", live, `evt_due_a_${Date.now()}`),
      );

      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: live.id, customer: customerId, status: "past_due" }),
      );
      await handleSubscriptionEvent(
        event("customer.subscription.updated", live, `evt_due_b_${Date.now()}`),
      );

      expect(await getUserMembershipTier(userId)).toBe("pro");
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — an upgrade that went unpaid (#106 §7.3)", () => {
  it("keeps the old tier and says the upgrade did not complete", async () => {
    const { userId, customerId } = await makeCustomerAccount();
    try {
      const pending = stripeSub({
        id: `sub_pend_${seq}`,
        customer: customerId,
        pending_update: {
          expires_at: 0,
          subscription_items: [{ id: "si_1", price: { id: TEAM_PRICE } }],
        },
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(pending);
      await handleSubscriptionEvent(
        event("customer.subscription.updated", pending, `evt_p_a_${Date.now()}`),
      );
      // The upgrade has not been paid, so the ceilings are still PRO's.
      expect(await getUserMembershipTier(userId)).toBe("pro");

      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        stripeSub({ id: pending.id, customer: customerId }),
      );
      await handleSubscriptionEvent(
        event(
          "customer.subscription.pending_update_expired",
          pending,
          `evt_p_b_${Date.now()}`,
        ),
      );

      expect(await getUserMembershipTier(userId)).toBe("pro");
      const bells = await sql<{ type: string; payload: unknown }[]>`
        SELECT type, payload FROM notifications WHERE user_id = ${userId}
      `;
      expect(bells.map((b) => b.type)).toEqual([
        "membership.upgrade_incomplete",
      ]);
      expect(bells[0]?.payload).toEqual({ toTier: "team" });
    } finally {
      await dropUser(userId);
    }
  });
});

describe("handleSubscriptionEvent — what it will not touch", () => {
  it("ignores an event that is not about a subscription", async () => {
    const outcome = await handleSubscriptionEvent(
      event("invoice.paid", stripeSub(), `evt_other_${Date.now()}`),
    );
    expect(outcome.status).toBe("ignored");
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("leaves the event unprocessed when the price is not one we sell", async () => {
    // An operator could add a price in Stripe that this deployment's config
    // does not know. Marking the event handled would drop it for good; leaving
    // it unmarked keeps a manual redelivery able to fix things.
    const { userId, customerId } = await makeCustomerAccount();
    const eventId = `evt_price_${Date.now()}`;
    try {
      const sub = stripeSub({
        id: `sub_price_${seq}`,
        customer: customerId,
        items: {
          data: [
            {
              id: "si_1",
              current_period_end: PERIOD_END,
              price: { id: "price_never_configured" },
            },
          ],
        },
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(sub);

      const outcome = await handleSubscriptionEvent(
        event("customer.subscription.created", sub, eventId),
      );

      expect(outcome.status).toBe("ignored");
      const marks = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM stripe_webhook_events
        WHERE event_id = ${eventId}
      `;
      expect(marks[0]?.count).toBe("0");
      expect(await getUserMembershipTier(userId)).toBe("base");
    } finally {
      await sql`DELETE FROM stripe_webhook_events WHERE event_id = ${eventId}`;
      await dropUser(userId);
    }
  });
});
