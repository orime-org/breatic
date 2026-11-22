// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Invariants of the product's money receivers (inner#1993 §10.1 rows 1-3),
 * run on the real receivers against the test database:
 *
 * - a payment grant replayed any number of times, one after another or at
 *   once, opens exactly one lot whose ledger sums to the purchased credits and
 *   answers the same lot every time;
 * - subscription facts delivered in any order leave the projection on the
 *   fact observed last, and the account on the tier that fact alone gives;
 * - a refund step repeated under one operation, one after another or at once,
 *   moves the lot once, exactly as a single delivery of it does, and every
 *   repeat gets the same answer.
 */

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { closeDb, initCore, STRIPE_SUBSCRIPTION_STATUSES, type PaymentGrantRequest, type RefundStep, type SubscriptionFactRequest } from "@breatic/core";
import type * as Core from "@breatic/core";
import type * as SettleTier from "@server/modules/account/settle-tier.js";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";
import { applyRefundStep } from "@server/modules/commerce/commerce-refund-steps.service.js";
import { applySubscriptionFact } from "@server/modules/commerce/commerce-subscription-facts.service.js";
import { grantPayment } from "@server/modules/commerce/payment-grant.service.js";

vi.mock("@breatic/core", async (original) => ({
  ...(await original<typeof Core>()),
  trackServerEvent: vi.fn(),
  enqueueAdsConversion: vi.fn(async () => true),
  accountOnlyConsent: vi.fn(async () => ({ analytics: false, ads: false })),
}));
vi.mock("@server/modules/account/settle-tier.js", async (original) => ({
  ...(await original<typeof SettleTier>()),
  sendMembershipEndedMail: vi.fn(async () => undefined),
}));

const NUM_RUNS = 15;
const MODES = ["sequential", "concurrent"] as const;

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-receiver-properties-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * One account on the base tier.
 * @returns Its id.
 */
async function account(): Promise<string> {
  const userId = randomUUID();
  await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  return userId;
}

/**
 * Send the same call several times.
 * @param times - How many.
 * @param mode - One after another, or all at once.
 * @param call - The call.
 * @returns Every answer, in sending order.
 */
async function repeat(times: number, mode: (typeof MODES)[number], call: () => Promise<StoredAnswer>): Promise<StoredAnswer[]> {
  if (mode === "concurrent") return Promise.all(Array.from({ length: times }, call));
  const answers: StoredAnswer[] = [];
  for (let i = 0; i < times; i++) answers.push(await call());
  return answers;
}

describe("payment-grants", () => {
  it.each(MODES)("opens one lot for any number of %s replays and answers it every time", async (mode) => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 100_000 }), async (times, credits) => {
        const userId = await account();
        const paymentId = randomUUID();
        const request: PaymentGrantRequest = {
          userId,
          purchasedCredits: credits,
          amountCents: 1000,
          taxCents: null,
          totalCents: null,
          currency: "usd",
          orderedAt: "2026-11-19T10:00:00.000Z",
          conversion: { consent: { analytics: false, ads: false }, click: null, transactionId: `tx-${paymentId}` },
        };

        const answers = await repeat(times, mode, () => grantPayment(paymentId, request));

        const lots = await sql<{ id: string }[]>`SELECT id FROM credit_lots WHERE source_id = ${paymentId}`;
        expect(lots).toHaveLength(1);
        const [ledger] = await sql<{ sum: string }[]>`SELECT coalesce(sum(amount), 0)::text AS sum FROM credit_ledger WHERE lot_id = ${lots[0]!.id}`;
        expect(Number(ledger!.sum)).toBe(credits);
        for (const answer of answers) {
          expect(answer).toEqual(answers[0]);
          expect(answer).toMatchObject({ httpStatus: 200, body: { lotId: lots[0]!.id } });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("subscription-facts", () => {
  const factShape = fc.record({
    offsetSeconds: fc.integer({ min: 0, max: 1_000_000 }),
    tier: fc.constantFrom("pro" as const, "team" as const),
    period: fc.constantFrom("month" as const, "year" as const),
    status: fc.constantFrom(...STRIPE_SUBSCRIPTION_STATUSES),
    cancelAtPeriodEnd: fc.boolean(),
  });
  /** One generated fact. */
  type GeneratedFact = typeof factShape extends fc.Arbitrary<infer T> ? T : never;
  const deliveries = fc
    .uniqueArray(factShape, { selector: (f) => f.offsetSeconds, minLength: 1, maxLength: 6 })
    .chain((facts) => fc.tuple(fc.constant(facts), fc.shuffledSubarray(facts, { minLength: facts.length, maxLength: facts.length })));

  /**
   * The request one generated fact becomes.
   * @param userId - Whose.
   * @param subscriptionId - Stripe's id.
   * @param fact - The generated fact.
   * @returns The request.
   */
  function factRequest(userId: string, subscriptionId: string, fact: GeneratedFact): SubscriptionFactRequest {
    return {
      userId,
      fact: {
        stripeSubscriptionId: subscriptionId,
        tier: fact.tier,
        period: fact.period,
        status: fact.status,
        currentPeriodEnd: "2099-01-01T00:00:00.000Z",
        cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
        hasPendingUpdate: false,
        pendingTier: null,
        pendingPeriod: null,
        observedAt: new Date(Date.parse("2026-11-20T00:00:00.000Z") + fact.offsetSeconds * 1000).toISOString(),
        firstActiveAt: "2026-11-19T00:00:00.000Z",
      },
      notices: [],
      started: null,
      referenceId: "evt_property",
    };
  }

  /**
   * What the product holds for one subscription and its account.
   * @param subscriptionId - Stripe's id.
   * @returns The projection and the account's tier.
   */
  async function stored(subscriptionId: string): Promise<unknown> {
    return sql`
      SELECT s.tier, s.period, s.status, s.cancel_at_period_end, s.current_period_end, s.first_active_at, s.observed_at, u.membership_tier
      FROM subscriptions s JOIN users u ON u.id = s.user_id
      WHERE s.stripe_subscription_id = ${subscriptionId}`;
  }

  it("keeps the fact observed last, in any delivery order, and the tier that fact alone gives", async () => {
    await fc.assert(
      fc.asyncProperty(deliveries, async ([facts, order]) => {
        const userId = await account();
        const sub = `sub_${randomUUID()}`;
        for (const fact of order) {
          expect((await applySubscriptionFact(randomUUID(), factRequest(userId, sub, fact))).httpStatus).toBe(200);
        }
        const latest = facts.reduce((a, b) => (b.offsetSeconds > a.offsetSeconds ? b : a));
        const fresh = await account();
        const freshSub = `sub_${randomUUID()}`;
        await applySubscriptionFact(randomUUID(), factRequest(fresh, freshSub, latest));

        const [projection] = (await stored(sub)) as Array<Record<string, unknown>>;
        expect(projection).toMatchObject({
          tier: latest.tier,
          period: latest.period,
          status: latest.status,
          cancel_at_period_end: latest.cancelAtPeriodEnd,
          observed_at: new Date(factRequest(userId, sub, latest).fact.observedAt),
        });
        expect(await stored(sub)).toEqual(await stored(freshSub));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("refund-steps", () => {
  /** Each step, where the lot stands before it, and whether a settle comes first. */
  const EDGES: Array<{ step: RefundStep; from: string; settledFirst: boolean }> = [
    { step: "mark_refunding", from: "refund_pending", settledFirst: false },
    { step: "settle", from: "refunding", settledFirst: false },
    { step: "send_back", from: "refunding", settledFirst: false },
    { step: "reject", from: "refund_pending", settledFirst: false },
    { step: "restore", from: "refunding", settledFirst: true },
  ];

  /**
   * A bought lot of 1000 credits standing where the edge starts.
   * @param edge - The edge to take.
   * @returns The lot and its owner.
   */
  async function lotFor(edge: (typeof EDGES)[number]): Promise<{ lotId: string; userId: string }> {
    const userId = await account();
    const sourceId = randomUUID();
    await sql`INSERT INTO credit_sources(id,kind) VALUES (${sourceId},'payment')`;
    const [row] = await sql<{ id: string }[]>`INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
      VALUES (${sourceId},'payment',${userId},1000,1000,${edge.from}) RETURNING id`;
    await sql`INSERT INTO credit_ledger(payer_user_id,lot_id,entry_type,amount) VALUES (${userId},${row!.id},'topup','1000')`;
    if (edge.settledFirst) {
      const settled = await applyRefundStep(randomUUID(), "settle", { lotId: row!.id, step: "settle", referenceId: `re_${randomUUID()}`, settled: { amountCents: 1000, currency: "usd" }, tell: null });
      expect(settled.httpStatus).toBe(200);
    }
    return { lotId: row!.id, userId };
  }

  /**
   * What a step changed: the lot, its ledger after the seed, its notices.
   * @param lot - The lot and its owner.
   * @param lot.lotId - The lot.
   * @param lot.userId - Its owner.
   * @returns The facts, free of ids that differ between lots.
   */
  async function effects(lot: { lotId: string; userId: string }): Promise<unknown> {
    const [state] = await sql`SELECT lifecycle, remaining_credits::text AS remaining, refund_attempts FROM credit_lots WHERE id = ${lot.lotId}`;
    const ledger = await sql`SELECT entry_type, amount::text AS amount FROM credit_ledger WHERE lot_id = ${lot.lotId} ORDER BY created_at, entry_type`;
    const notices = await sql`SELECT type FROM notifications WHERE user_id = ${lot.userId} ORDER BY type`;
    return { state, ledger, notices };
  }

  it.each(MODES)("moves the lot once, as one delivery does, for any number of %s repeats", async (mode) => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...EDGES), fc.integer({ min: 1, max: 5 }), fc.boolean(), async (edge, times, tells) => {
        const tell = !tells
          ? null
          : edge.step === "settle"
            ? { kind: "refund_completed" as const }
            : edge.step === "reject"
              ? { kind: "refund_rejected" as const }
              : edge.step === "restore"
                ? { kind: "refund_restored" as const }
                : null;
        const settled = edge.step === "settle" ? { amountCents: 1000, currency: "usd" } : null;
        const once = await lotFor(edge);
        const onceOperation = randomUUID();
        const onceAnswer = await applyRefundStep(onceOperation, edge.step, { lotId: once.lotId, step: edge.step, referenceId: onceOperation, settled, tell });
        expect(onceAnswer.httpStatus).toBe(200);

        const lot = await lotFor(edge);
        const operationId = randomUUID();
        const request = { lotId: lot.lotId, step: edge.step, referenceId: operationId, settled, tell };
        const answers = await repeat(times, mode, () => applyRefundStep(operationId, edge.step, request));

        for (const answer of answers) expect(answer).toEqual(answers[0]);
        expect(answers[0]!.httpStatus).toBe(200);
        expect(await effects(lot)).toEqual(await effects(once));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
