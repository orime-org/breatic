// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The billing service stores what Stripe said about a subscription through
 * the product (inner#1993 §3.3 `subscription-facts`, §4.3): the projection is
 * upserted by `observedAt`, `first_active_at` keeps its first non-null value
 * even when the snapshot itself is older, the tier is settled, notices are
 * written in the same transaction, and the ended-membership email and the
 * start report go out after the commit, once per delivery.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { closeDb, initCore, type SubscriptionFactRequest } from "@breatic/core";
import type * as Core from "@breatic/core";
import type * as SettleTier from "@server/modules/account/settle-tier.js";
import { applySubscriptionFact } from "@server/modules/commerce/commerce-subscription-facts.service.js";

const track = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn(async () => true));
const endedMail = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@breatic/core", async (original) => ({
  ...(await original<typeof Core>()),
  trackServerEvent: track,
  enqueueAdsConversion: enqueue,
}));
vi.mock("@server/modules/account/settle-tier.js", async (original) => ({
  ...(await original<typeof SettleTier>()),
  sendMembershipEndedMail: endedMail,
}));

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-subscription-facts-test" } });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * One account on the base tier.
 * @param deleted - Whether it is soft-deleted.
 * @returns Its id.
 */
async function account(deleted = false): Promise<string> {
  const userId = randomUUID();
  await sql`INSERT INTO users(id,email,deleted_at) VALUES (${userId},${`${userId}@example.test`},${deleted ? new Date() : null})`;
  return userId;
}

/**
 * A PRO monthly fact for one subscription.
 * @param userId - Whose.
 * @param subscriptionId - Stripe's id.
 * @param overrides - Fact fields to change.
 * @returns The request.
 */
function request(userId: string, subscriptionId: string, overrides: Partial<SubscriptionFactRequest["fact"]> = {}): SubscriptionFactRequest {
  return {
    userId,
    fact: {
      stripeSubscriptionId: subscriptionId,
      tier: "pro",
      period: "month",
      status: "active",
      currentPeriodEnd: "2099-01-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      hasPendingUpdate: false,
      pendingTier: null,
      pendingPeriod: null,
      observedAt: "2026-11-20T10:00:00.000Z",
      firstActiveAt: "2026-11-20T09:59:00.000Z",
      ...overrides,
    },
    notices: [],
    started: null,
    referenceId: "evt_test",
  };
}

describe("applySubscriptionFact", () => {
  it("stores the subscription, its first payment and the tier it brings", async () => {
    const userId = await account();
    const sub = `sub_${randomUUID()}`;

    const answer = await applySubscriptionFact(randomUUID(), request(userId, sub));

    expect(answer).toEqual({ httpStatus: 200, body: { tier: "pro", endedFrom: null } });
    expect(await sql`SELECT status, tier, first_active_at, stripe_item_id FROM subscriptions WHERE stripe_subscription_id = ${sub}`).toEqual([
      { status: "active", tier: "pro", first_active_at: new Date("2026-11-20T09:59:00.000Z"), stripe_item_id: null },
    ]);
    expect(await sql`SELECT membership_tier FROM users WHERE id = ${userId}`).toEqual([{ membership_tier: "pro" }]);
  });

  it("writes the reference the billing service sent on the tier ledger row", async () => {
    const userId = await account();

    await applySubscriptionFact(randomUUID(), { ...request(userId, `sub_${randomUUID()}`), referenceId: "evt_1QxTierMove" });

    expect(await sql`SELECT from_tier, to_tier, reference_id FROM membership_tier_changes WHERE user_id = ${userId}`).toEqual([
      { from_tier: "base", to_tier: "pro", reference_id: "evt_1QxTierMove" },
    ]);
  });

  it("records the first payment from an older snapshot the projection skips", async () => {
    const userId = await account();
    const sub = `sub_${randomUUID()}`;
    await applySubscriptionFact(randomUUID(), request(userId, sub, { status: "incomplete", firstActiveAt: null, observedAt: "2026-11-20T11:00:00.000Z" }));

    await applySubscriptionFact(randomUUID(), request(userId, sub, { observedAt: "2026-11-20T10:00:00.000Z" }));

    expect(await sql`SELECT status, first_active_at FROM subscriptions WHERE stripe_subscription_id = ${sub}`).toEqual([
      { status: "incomplete", first_active_at: new Date("2026-11-20T09:59:00.000Z") },
    ]);
  });

  it("keeps the first payment time a later fact disagrees with", async () => {
    const userId = await account();
    const sub = `sub_${randomUUID()}`;
    await applySubscriptionFact(randomUUID(), request(userId, sub));

    await applySubscriptionFact(randomUUID(), request(userId, sub, { observedAt: "2026-11-20T12:00:00.000Z", firstActiveAt: "2026-11-20T11:00:00.000Z" }));

    expect(await sql`SELECT first_active_at FROM subscriptions WHERE stripe_subscription_id = ${sub}`).toEqual([
      { first_active_at: new Date("2026-11-20T09:59:00.000Z") },
    ]);
  });

  it("writes its notices in the same transaction", async () => {
    const userId = await account();
    const r = { ...request(userId, `sub_${randomUUID()}`), notices: [{ type: "membership_upgrade_incomplete" as const, toTier: "team" as const, toPeriod: "year" as const }] };

    await applySubscriptionFact(randomUUID(), r);

    expect(await sql`SELECT type, payload FROM notifications WHERE user_id = ${userId}`).toEqual([
      { type: "membership.upgrade_incomplete", payload: { toTier: "team", toPeriod: "year" } },
    ]);
  });

  it("mails the end of a paid membership and reports a start, after the commit and once per delivery", async () => {
    const userId = await account();
    const sub = `sub_${randomUUID()}`;
    const started: SubscriptionFactRequest["started"] = {
      properties: { tier: "pro", interval: "month", amountCents: 2000, currency: "usd" },
      consent: { analytics: true, ads: true },
      click: null,
      transactionId: `sub:${sub}`,
    };
    const delivery = randomUUID();
    await applySubscriptionFact(delivery, { ...request(userId, sub), started });
    await applySubscriptionFact(delivery, { ...request(userId, sub), started });

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      "subscription_started",
      { userId, insertId: `sub:${sub}`, properties: { tier: "pro", interval: "month", amount_cents: 2000, currency: "usd" } },
      { analytics: true, ads: true },
    );
    expect(enqueue).toHaveBeenCalledTimes(1);

    const ended = await applySubscriptionFact(randomUUID(), request(userId, sub, { status: "canceled", observedAt: "2026-11-21T10:00:00.000Z" }));

    expect(ended).toEqual({ httpStatus: 200, body: { tier: "base", endedFrom: "pro" } });
    expect(endedMail).toHaveBeenCalledWith(userId, "pro");
  });

  it("refuses an account that is deleted or never existed and writes nothing", async () => {
    const gone = await account(true);
    const sub = `sub_${randomUUID()}`;

    expect(await applySubscriptionFact(randomUUID(), request(gone, sub))).toEqual({ httpStatus: 404, body: { code: "account_not_found" } });
    expect(await applySubscriptionFact(randomUUID(), request(randomUUID(), sub))).toEqual({ httpStatus: 404, body: { code: "account_not_found" } });
    expect(await sql`SELECT 1 FROM subscriptions WHERE stripe_subscription_id = ${sub}`).toHaveLength(0);
  });
});
