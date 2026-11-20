// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product's half of the billing contract (inner#1993 §7.4): every request
 * the shared schemas in `core/src/commerce/contract.ts` accept, signed as the
 * billing service, is answered without a server error; a 2xx answer parses
 * with the endpoint's answer schema, and every other answer is the internal
 * refusal shape. Requests mix a real account and lot with unknown ids, so
 * both the applying and the refusing branches answer.
 */

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { z } from "zod";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ADS_CONVERSIONS,
  REFUND_STEPS,
  STRIPE_SUBSCRIPTION_STATUSES,
  accountFactsSchema,
  accountLookupAnswerSchema,
  conversionAnswerSchema,
  lotRefundFactsSchema,
  paymentGrantAnswerSchema,
  refundStepAnswerSchema,
  subscriptionFactAnswerSchema,
} from "@breatic/core";
import { ANALYTICS_EVENT_NAMES, BILLING_PERIODS, MEMBERSHIP_TIERS } from "@breatic/shared";
import { COMMERCE_SECRET, call, useInternalApp, type CallOptions } from "./internal-api-harness.js";

const suite = useInternalApp("commerce-contract");
const refusalSchema = z.object({ code: z.string().min(1) }).passthrough();

/** A real account with an active lot and a lot whose refund was asked for, filled before the first property runs. */
const seeded = { userId: "", lotId: "", pendingLotId: "" };

/**
 * One lot the account holds.
 * @param userId - Whose lot.
 * @param lifecycle - Where it stands.
 * @returns Its id.
 */
async function insertLot(userId: string, lifecycle: "active" | "refund_pending"): Promise<string> {
  const sourceId = randomUUID();
  await suite.sql`INSERT INTO credit_sources(id,kind) VALUES (${sourceId},'payment')`;
  const [lot] = await suite.sql<{ id: string }[]>`INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
    VALUES (${sourceId},'payment',${userId},1000,1000,${lifecycle}) RETURNING id`;
  return lot!.id;
}

/**
 * One account with a personal Studio, an active lot and a lot whose refund was asked for.
 * @returns Its id and the two lots' ids.
 */
async function seed(): Promise<typeof seeded> {
  const userId = randomUUID();
  await suite.sql`INSERT INTO users(id,email,locale) VALUES (${userId},${`${userId}@example.test`},'en')`;
  await suite.sql`INSERT INTO studios(id,created_by_user_id,slug,name,type) VALUES (${randomUUID()},${userId},${userId.slice(0, 30)},'Contract','personal')`;
  return { userId, lotId: await insertLot(userId, "active"), pendingLotId: await insertLot(userId, "refund_pending") };
}

beforeAll(async () => {
  Object.assign(seeded, await seed());
});

/**
 * Send one request signed by the billing service.
 * @param path - Path under the commerce prefix.
 * @param opts - What to send.
 * @returns What came back.
 */
function commerce(path: string, opts: CallOptions = {}): ReturnType<typeof call> {
  return call(suite.baseUrl, `/internal/v1/commerce${path}`, { admin: "commerce", secret: COMMERCE_SECRET, ...opts });
}

/**
 * Hold one answer to the contract.
 * @param answer - What came back.
 * @param answer.status - Its status.
 * @param answer.json - Its body.
 * @param schema - The endpoint's answer schema.
 */
function expectContractAnswer(answer: { status: number; json: unknown }, schema: z.ZodTypeAny): void {
  expect(answer.status, JSON.stringify(answer.json)).toBeLessThan(500);
  if (answer.status >= 200 && answer.status < 300) {
    const parsed = schema.safeParse(answer.json);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  } else {
    expect(refusalSchema.safeParse(answer.json).success, JSON.stringify(answer.json)).toBe(true);
  }
}

const RUNS = { numRuns: 25 };
const instant = fc.date({ min: new Date("2020-01-01T00:00:00Z"), max: new Date("2030-01-01T00:00:00Z"), noInvalidDate: true }).map((d) => d.toISOString());
const text = (max: number): fc.Arbitrary<string> => fc.string({ minLength: 1, maxLength: max });
const userId = (): fc.Arbitrary<string> => fc.oneof(fc.constant(seeded.userId), fc.uuid());
const lotId = (): fc.Arbitrary<string> => fc.oneof(fc.constant(seeded.lotId), fc.constant(seeded.pendingLotId), fc.uuid());
const consent = fc.record({ analytics: fc.boolean(), ads: fc.boolean() });
const click = fc.option(
  fc.record({ gclid: fc.option(text(40), { nil: undefined }), gbraid: fc.option(text(40), { nil: undefined }), wbraid: fc.option(text(40), { nil: undefined }), at: text(40) }, { requiredKeys: ["at"] }),
  { nil: null },
);
const cents = fc.nat();
const currency = text(10);
const tier = fc.constantFrom(...MEMBERSHIP_TIERS);
const period = fc.constantFrom(...BILLING_PERIODS);

describe("the billing contract, product side", () => {
  it("reads an account", async () => {
    await fc.assert(
      fc.asyncProperty(userId(), async (id) => expectContractAnswer(await commerce(`/accounts/${id}`), accountFactsSchema)),
      RUNS,
    );
  });

  it("looks accounts up", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(userId(), { minLength: 1, maxLength: 100 }), async (userIds) =>
        expectContractAnswer(await commerce("/accounts/lookup", { body: { userIds } }), accountLookupAnswerSchema),
      ),
      RUNS,
    );
  });

  it("reads lots' refund facts", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(lotId(), { minLength: 1, maxLength: 100 }), async (lotIds) =>
        expectContractAnswer(await commerce("/refund-lots/facts", { body: { lotIds } }), z.array(lotRefundFactsSchema)),
      ),
      RUNS,
    );
  });

  it("takes a conversion report", async () => {
    const report = fc.record({
      name: fc.constantFrom(...ANALYTICS_EVENT_NAMES),
      userId: userId(),
      insertId: text(200),
      properties: fc.dictionary(fc.string({ maxLength: 12 }), fc.oneof(fc.string({ maxLength: 20 }), fc.integer(), fc.boolean())),
      consent: fc.oneof(consent, fc.constant("account" as const)),
      ads: fc.option(
        fc.record({ conversion: fc.constantFrom(...ADS_CONVERSIONS), transactionId: text(64), click, value: fc.option(fc.record({ amountCents: cents, currency }), { nil: null }) }),
        { nil: null },
      ),
    });
    await fc.assert(
      fc.asyncProperty(report, async (body) => expectContractAnswer(await commerce("/conversions", { body }), conversionAnswerSchema)),
      RUNS,
    );
  });

  it("stores a subscription fact", async () => {
    const request = fc.record({
      userId: userId(),
      fact: fc.record({
        stripeSubscriptionId: text(255),
        tier,
        period,
        status: fc.constantFrom(...STRIPE_SUBSCRIPTION_STATUSES),
        currentPeriodEnd: fc.option(instant, { nil: null }),
        cancelAtPeriodEnd: fc.boolean(),
        hasPendingUpdate: fc.boolean(),
        pendingTier: fc.option(tier, { nil: null }),
        pendingPeriod: fc.option(period, { nil: null }),
        observedAt: instant,
        firstActiveAt: fc.option(instant, { nil: null }),
      }),
      notices: fc.array(fc.record({ type: fc.constant("membership_upgrade_incomplete" as const), toTier: tier, toPeriod: period }), { maxLength: 10 }),
      started: fc.option(
        fc.record({ properties: fc.record({ tier, interval: period, amountCents: cents, currency }), consent, click, transactionId: text(64) }),
        { nil: null },
      ),
    });
    await fc.assert(
      fc.asyncProperty(fc.uuid(), request, async (deliveryId, body) =>
        expectContractAnswer(await commerce(`/subscription-facts/${deliveryId}`, { method: "PUT", body }), subscriptionFactAnswerSchema),
      ),
      RUNS,
    );
  });

  it("grants a payment", async () => {
    const request = fc.record({
      userId: userId(),
      purchasedCredits: fc.double({ min: Number.MIN_VALUE, max: 1e9, noNaN: true, noDefaultInfinity: true }),
      amountCents: cents,
      taxCents: fc.option(cents, { nil: null }),
      totalCents: fc.option(cents, { nil: null }),
      currency,
      orderedAt: instant,
      conversion: fc.record({ consent, click, transactionId: text(200) }),
    });
    await fc.assert(
      fc.asyncProperty(fc.uuid(), request, async (paymentId, body) =>
        expectContractAnswer(await commerce(`/payment-grants/${paymentId}`, { body }), paymentGrantAnswerSchema),
      ),
      RUNS,
    );
  });

  it("moves a lot one refund step", async () => {
    const tell = fc.option(
      fc.oneof(
        fc.record({ kind: fc.constant("refund_completed" as const), amountCents: cents, currency }),
        fc.record({ kind: fc.constant("refund_rejected" as const) }),
        fc.record({ kind: fc.constant("refund_restored" as const) }),
      ),
      { nil: null },
    );
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.constantFrom(...REFUND_STEPS), lotId(), text(255), tell, async (operationId, step, lot, referenceId, told) => {
        const answer = await commerce(`/refund-steps/${operationId}/${step}`, { body: { lotId: lot, step, referenceId, tell: told } });
        expectContractAnswer(answer, refundStepAnswerSchema);
        // A lot no longer where the edge starts is refused with the lot as it stands.
        if (answer.status === 409) expect(refundStepAnswerSchema.parse(answer.json).status).toBe("refused");
      }),
      RUNS,
    );
  });
});
