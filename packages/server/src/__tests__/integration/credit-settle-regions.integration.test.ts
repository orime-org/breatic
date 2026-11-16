// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settling a region's charge in the global credit ledger (inner#1955) — real PG.
 *
 * A region records a charge request in its own task transaction and then asks
 * the global region to settle it. The answer can be lost and the region's
 * sweep asks again, so the global side settles each (region, request id)
 * exactly once: the first call charges and records the outcome, every later
 * call returns that outcome and charges nothing. The Studio that pays is the
 * one the request names; the global region holds no projects to look it up in.
 *
 * The pins:
 *
 *   1. Settling the same request twice charges once and answers the same.
 *   2. The same request id from another region is a different charge.
 *   3. The request's studio pays, with a project the global region has never
 *      seen.
 *   4. Property: over any sequence of settlements with repeats, the Studio is
 *      charged once per distinct (region, request id).
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import { seedDesignatedLot, seedStudioFixture, type StudioFixture } from "./studio-credit-fixtures.js";

loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    // Only the start-up check reads these; no Stripe call is made here.
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    REGION: "us-west",
    GLOBAL_REGION: "us-west",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "credit-settle-regions-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A team Studio with its live directory row and a designated purchase.
 * @param credits - What the purchase grants.
 * @returns The fixture and the lot id.
 */
async function fundedStudio(credits: number): Promise<{ fx: StudioFixture; lotId: string }> {
  const fx = await seedStudioFixture(sql, "settle-region");
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${fx.studioId}, ${`settle-${crypto.randomBytes(5).toString("hex")}`}, 'sg', 'team', 'Settle',
            ${fx.userId}, ${fx.userId}, 'live')
    ON CONFLICT (studio_id) DO UPDATE SET region = EXCLUDED.region
  `;
  const lotId = await seedDesignatedLot(sql, fx, credits);
  return { fx, lotId };
}

/**
 * A region's charge request for one credit's worth of work.
 * @param fx - Whose Studio pays.
 * @param region - The region that recorded it.
 * @param requestId - Its id in that region.
 * @param amount - What to charge.
 * @returns The request as the region sends it.
 */
function request(
  fx: StudioFixture,
  region: string,
  requestId: string,
  amount = 1,
): creditLotService.RegionalChargeRequest {
  return {
    region,
    requestId,
    kind: "task",
    actorUserId: fx.userId,
    studioId: fx.studioId,
    projectId: crypto.randomUUID(),
    amount,
    referenceId: `task-${requestId}`,
  };
}

/**
 * What a lot still holds.
 * @param lotId - The lot.
 * @returns Its remaining credits.
 */
async function remaining(lotId: string): Promise<number> {
  const [row] = await sql<{ remaining: string }[]>`SELECT remaining_credits AS remaining FROM credit_lots WHERE id = ${lotId}`;
  return Number(row!.remaining);
}

describe("settling a regional charge in the global ledger", () => {
  it("charges once and answers the same when the same request is settled twice", async () => {
    const { fx, lotId } = await fundedStudio(10);
    const req = request(fx, "sg", crypto.randomUUID(), 2);

    const first = await creditLotService.settleRegionalCharge(req);
    const second = await creditLotService.settleRegionalCharge(req);

    expect(second).toEqual(first);
    expect(await remaining(lotId)).toBe(8);
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger WHERE reference_id = ${req.referenceId} AND entry_type = 'spend'
    `;
    expect(row!.n).toBe(1);
  });

  it("treats the same request id from another region as a different charge", async () => {
    const { fx, lotId } = await fundedStudio(10);
    const requestId = crypto.randomUUID();

    await creditLotService.settleRegionalCharge(request(fx, "sg", requestId));
    await creditLotService.settleRegionalCharge({ ...request(fx, "eu", requestId), referenceId: `eu-${requestId}` });

    expect(await remaining(lotId)).toBe(8);
  });

  it("charges the Studio the request names, for a project this region has never seen", async () => {
    const { fx, lotId } = await fundedStudio(10);

    const outcome = await creditLotService.settleRegionalCharge(request(fx, "sg", crypto.randomUUID(), 3));

    expect(outcome.studioId).toBe(fx.studioId);
    expect(outcome.lotIds).toEqual([lotId]);
    expect(await remaining(lotId)).toBe(7);
  });

  it("charges once per distinct region and request id over any sequence of retries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ region: fc.constantFrom("sg", "eu"), key: fc.integer({ min: 0, max: 3 }) }), {
          minLength: 1,
          maxLength: 10,
        }),
        async (calls) => {
          const { fx, lotId } = await fundedStudio(20);
          const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
          for (const call of calls) {
            const requestId = ids[call.key]!;
            await creditLotService.settleRegionalCharge({
              ...request(fx, call.region, requestId),
              referenceId: `${call.region}-${requestId}`,
            });
          }
          const distinct = new Set(calls.map((call) => `${call.region}:${call.key}`)).size;
          expect(await remaining(lotId)).toBe(20 - distinct);
        },
      ),
      { numRuns: 15 },
    );
  });
});
