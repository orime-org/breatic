// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The credit ledger stays whole when Studios live in regions (inner#1955,
 * acceptance 5) — real PG.
 *
 * The global region keeps every credit book; a Studio in another region is
 * known to it only through its directory row. A region's settlement can stop
 * after the global commit and before the region marks its request, and a
 * transfer can stop after the global admin change and before the region swaps
 * roles; both must end in the state they would have reached without stopping.
 *
 * The pins:
 *
 *   1. A Studio known only by its directory row can be funded and spent from:
 *      the charge takes the designated purchase and records no debt.
 *   2. A settlement that stopped after the global commit, retried through the
 *      region's own path, charges nothing more and marks the request settled.
 *   3. The admin's overview, ledger and spent figure all show a remote
 *      Studio's spending and debt.
 *   4. A transfer the global region refuses leaves the offer invalidated and
 *      the roles as they were.
 *   5. A transfer whose global change committed but whose region step did not
 *      is finished by the sweep: roles swapped, offer accepted.
 *   6. Property: over any sequence of admissions, settlements, repeated
 *      settlements, designations and admin changes, every credit bought is
 *      either still in a purchase or recorded as spent, and no request is
 *      charged twice.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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

import crypto from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { db, GlobalApiError, initCore, loadLocales, UNREACHABLE_STATUS } from "@breatic/core";
import { creditHoldService, creditLotService, globalApi, studioDirectoryService } from "@breatic/domain";
import * as creditViewService from "@server/modules/credit/credit-view.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import { openPaymentSource } from "./payment-source.js";
import { seedStudioFixture } from "./studio-credit-fixtures.js";

loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

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
    connection: { application_name: "credit-regions-consistency-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account.
 * @returns Its id.
 */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`consistency-${Date.now()}-${seq++}@example.test`}, true)
    RETURNING id
  `;
  return row!.id;
}

/**
 * A directory row for a team Studio in `sg`, with no local rows.
 * @param adminId - The admin the directory names.
 * @returns The Studio id.
 */
async function remoteStudio(adminId: string): Promise<string> {
  const studioId = crypto.randomUUID();
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${studioId}, ${`cons-${crypto.randomBytes(5).toString("hex")}`}, 'sg', 'team', 'Remote',
            ${adminId}, ${adminId}, 'live')
  `;
  return studioId;
}

/**
 * A purchase owned by a user, pointed at a Studio when given.
 * @param ownerId - The buyer.
 * @param credits - What it grants.
 * @param studioId - Where to point it, if anywhere.
 * @returns The lot id.
 */
async function purchase(ownerId: string, credits: number, studioId?: string): Promise<string> {
  const sourceId = await openPaymentSource(sql);
  await sql`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${sourceId}, ${ownerId}, 1000, 'completed', ${credits})
  `;
  const lot = await creditLotService.grantFromPayment({ paymentId: sourceId, userId: ownerId, purchasedCredits: credits });
  if (studioId !== undefined) await creditLotService.designateLot({ lotId: lot.id, requestingUserId: ownerId, studioId });
  return lot.id;
}

/**
 * A regional charge request.
 * @param actorUserId - Who ran the work.
 * @param studioId - Who pays.
 * @param amount - What to charge.
 * @param requestId - The region's request id.
 * @returns The request.
 */
function charge(
  actorUserId: string,
  studioId: string,
  amount: number,
  requestId: string = crypto.randomUUID(),
): creditLotService.RegionalChargeRequest {
  return {
    region: "sg",
    requestId,
    kind: "task",
    actorUserId,
    studioId,
    projectId: crypto.randomUUID(),
    amount,
    referenceId: `sg-${requestId}`,
  };
}

/**
 * What a Studio owes.
 * @param studioId - The Studio.
 * @returns Its debt, zero when it has no debt row.
 */
async function debt(studioId: string): Promise<number> {
  const [row] = await sql<{ owed: string }[]>`SELECT amount AS owed FROM studio_credit_debts WHERE studio_id = ${studioId}`;
  return row === undefined ? 0 : Number(row.owed);
}

describe("a Studio known only by its directory row", () => {
  it("spends its designated purchase and records no debt", async () => {
    const admin = await user();
    const studioId = await remoteStudio(admin);
    const lotId = await purchase(admin, 10, studioId);

    const outcome = await creditLotService.settleRegionalCharge(charge(admin, studioId, 4));

    expect(outcome.lotIds).toEqual([lotId]);
    expect(Number(outcome.shortfall)).toBe(0);
    expect(await debt(studioId)).toBe(0);
  });

  it("shows its spending and debt in the admin's overview, ledger and spent figure", async () => {
    const admin = await user();
    const studioId = await remoteStudio(admin);
    await purchase(admin, 5, studioId);
    await creditLotService.settleRegionalCharge(charge(admin, studioId, 8));

    const overview = await creditViewService.getOverview(admin);
    const summary = overview.studios.find((studio) => studio.studioId === studioId);
    expect(summary).toBeDefined();
    // What this account's money paid; the rest is the Studio's debt.
    expect(Number(summary!.spent)).toBe(5);
    expect(Number(summary!.debt)).toBe(3);

    const ledger = await creditViewService.listLedger(admin, undefined, undefined, studioId);
    expect(ledger.items.some((row) => row.studioId === studioId)).toBe(true);
  });
});

describe("a settlement that stopped after the global commit", () => {
  it("charges nothing more when the region retries it, and is marked settled", async () => {
    const fx = await seedStudioFixture(sql, "consistency-crash");
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${fx.studioId}, ${`crash-${crypto.randomBytes(5).toString("hex")}`}, NULL, 'team', 'Crash',
              ${fx.userId}, ${fx.userId}, 'live')
      ON CONFLICT (studio_id) DO NOTHING
    `;
    const lotId = await purchase(fx.userId, 10, fx.studioId);
    const referenceId = `crash-${crypto.randomUUID()}`;
    const requestId = await db.transaction((tx) =>
      creditLotService.requestCharge(
        {
          kind: "task",
          actorUserId: fx.userId,
          projectId: fx.projectId,
          studioId: fx.studioId,
          amount: 2,
          referenceId,
        },
        tx,
      ),
    );
    // The global commit happened; the region never heard back.
    await creditLotService.settleRegionalCharge({
      region: "us-west",
      requestId: requestId!,
      kind: "task",
      actorUserId: fx.userId,
      studioId: fx.studioId,
      projectId: fx.projectId,
      amount: 2,
      referenceId,
    });

    await creditLotService.settleCharge(requestId!);

    const [lot] = await sql<{ remaining: string }[]>`SELECT remaining_credits AS remaining FROM credit_lots WHERE id = ${lotId}`;
    expect(Number(lot!.remaining)).toBe(8);
    const [request] = await sql<{ status: string }[]>`SELECT status FROM credit_charge_requests WHERE id = ${requestId}`;
    expect(request!.status).toBe("settled");
  });
});

describe("a transfer across the global and region steps", () => {
  /**
   * A team Studio here with its directory row, an admin and a maintainer.
   * @returns Its id, slug and the two members.
   */
  async function localStudio(): Promise<{ studioId: string; slug: string; adminId: string; memberId: string }> {
    const adminId = await user();
    const memberId = await user();
    const slug = `cons-t-${crypto.randomBytes(5).toString("hex")}`;
    const [studio] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminId}, ${slug}, 'team', 'Local') RETURNING id
    `;
    const studioId = studio!.id;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${adminId}, 'admin')`;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${memberId}, 'maintainer')`;
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${studioId}, ${slug}, NULL, 'team', 'Local', ${adminId}, ${adminId}, 'live')
    `;
    return { studioId, slug, adminId, memberId };
  }

  /**
   * The role of a member.
   * @param studioId - The Studio.
   * @param userId - The member.
   * @returns The role.
   */
  async function role(studioId: string, userId: string): Promise<string> {
    const [row] = await sql<{ role: string }[]>`
      SELECT role FROM studio_members WHERE studio_id = ${studioId} AND user_id = ${userId} AND deleted_at IS NULL
    `;
    return row!.role;
  }

  it("leaves the offer invalidated and the roles unchanged when the global region refuses", async () => {
    const { studioId, slug, adminId, memberId } = await localStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [offer] = await sql<{ id: string }[]>`SELECT id FROM studio_transfers WHERE studio_id = ${studioId} AND status = 'pending'`;
    const someoneElse = await user();
    await sql`UPDATE studio_directory SET admin_user_id = ${someoneElse} WHERE studio_id = ${studioId}`;

    await expect(studioTransferService.confirmTransfer(offer!.id, memberId)).rejects.toBeDefined();

    const [after] = await sql<{ status: string; failed_reason: string | null }[]>`
      SELECT status, failed_reason FROM studio_transfers WHERE id = ${offer!.id}
    `;
    expect(after).toEqual({ status: "failed", failed_reason: "invalidated" });
    const [directory] = await sql<{ until: Date | null }[]>`
      SELECT transfer_pending_until AS until FROM studio_directory WHERE studio_id = ${studioId}
    `;
    expect(directory!.until).toBeNull();
    expect(await role(studioId, adminId)).toBe("admin");
    expect(await role(studioId, memberId)).toBe("maintainer");
  });

  it("tells the recipient the transfer is being processed when the global region does not answer, and the sweep finishes it", async () => {
    const { studioId, slug, adminId, memberId } = await localStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [offer] = await sql<{ id: string }[]>`SELECT id FROM studio_transfers WHERE studio_id = ${studioId} AND status = 'pending'`;
    vi.spyOn(globalApi(), "transferAdmin").mockRejectedValueOnce(new GlobalApiError(UNREACHABLE_STATUS, "unreachable", "timed out"));

    await expect(studioTransferService.confirmTransfer(offer!.id, memberId)).rejects.toMatchObject({
      statusCode: 409,
      reason: "studio_transfer_processing",
    });
    const [during] = await sql<{ status: string }[]>`SELECT status FROM studio_transfers WHERE id = ${offer!.id}`;
    expect(during!.status).toBe("accepting");

    await sql`UPDATE studio_transfers SET updated_at = now() - interval '5 minutes' WHERE id = ${offer!.id}`;
    await studioTransferService.sweepAcceptingTransfers({ olderThanMs: 60_000 });

    const [after] = await sql<{ status: string }[]>`SELECT status FROM studio_transfers WHERE id = ${offer!.id}`;
    expect(after!.status).toBe("accepted");
    expect(await role(studioId, memberId)).toBe("admin");
  });

  it("is finished by the sweep when the global change committed and the region step did not", async () => {
    const { studioId, slug, adminId, memberId } = await localStudio();
    await studioTransferService.requestTransfer(slug, adminId, memberId);
    const [offer] = await sql<{ id: string }[]>`SELECT id FROM studio_transfers WHERE studio_id = ${studioId} AND status = 'pending'`;
    await sql`UPDATE studio_transfers SET status = 'accepting', updated_at = now() - interval '5 minutes' WHERE id = ${offer!.id}`;
    await studioDirectoryService.changeDirectoryAdmin({ studioId, fromUserId: adminId, toUserId: memberId, changeId: offer!.id });

    await studioTransferService.sweepAcceptingTransfers({ olderThanMs: 60_000 });

    const [after] = await sql<{ status: string }[]>`SELECT status FROM studio_transfers WHERE id = ${offer!.id}`;
    expect(after!.status).toBe("accepted");
    expect(await role(studioId, memberId)).toBe("admin");
    expect(await role(studioId, adminId)).not.toBe("admin");
  });
});

describe("credit conservation across regions", () => {
  it("keeps every credit bought either in a purchase or recorded as spent, charging each request once", async () => {
    type Op =
      | { kind: "settle"; key: number; amount: number }
      | { kind: "hold"; amount: number }
      | { kind: "designate"; lot: number; to: number | null }
      | { kind: "changeAdmin"; to: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("settle" as const), key: fc.integer({ min: 0, max: 4 }), amount: fc.integer({ min: 1, max: 4 }) }),
      fc.record({ kind: fc.constant("hold" as const), amount: fc.integer({ min: 1, max: 4 }) }),
      fc.record({
        kind: fc.constant("designate" as const),
        lot: fc.integer({ min: 0, max: 1 }),
        to: fc.option(fc.integer({ min: 0, max: 1 }), { nil: null }),
      }),
      fc.record({ kind: fc.constant("changeAdmin" as const), to: fc.integer({ min: 0, max: 1 }) }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        const people = [await user(), await user()];
        const studios = [await remoteStudio(people[0]!), await remoteStudio(people[0]!)];
        const lots = [await purchase(people[0]!, 6, studios[0]), await purchase(people[0]!, 6)];
        const keys = Array.from({ length: 5 }, () => crypto.randomUUID());
        const charged = new Map<number, number>();
        let admin = 0;

        for (const step of ops) {
          if (step.kind === "settle") {
            await creditLotService.settleRegionalCharge(charge(people[0]!, studios[0]!, step.amount, keys[step.key]));
            if (!charged.has(step.key)) charged.set(step.key, step.amount);
          } else if (step.kind === "hold") {
            await creditHoldService.reserveCredits({
              studioId: studios[0]!,
              actorUserId: people[0]!,
              referenceId: `hold-${crypto.randomUUID()}`,
              amount: step.amount,
              ttlMs: 60_000,
            });
          } else if (step.kind === "designate") {
            await creditLotService
              .designateLot({
                lotId: lots[step.lot]!,
                requestingUserId: people[0]!,
                studioId: step.to === null ? null : studios[step.to]!,
              })
              .catch(() => undefined);
          } else {
            const result = await studioDirectoryService.changeDirectoryAdmin({
              studioId: studios[0]!,
              fromUserId: people[admin]!,
              toUserId: people[step.to]!,
              changeId: crypto.randomUUID(),
            });
            if (result.changed) admin = step.to;
          }
        }

        const [books] = await sql<{ bought: string; left: string }[]>`
          SELECT sum(purchased_credits) AS bought, sum(remaining_credits) AS left
          FROM credit_lots WHERE id = ANY(${lots})
        `;
        // A purchase is drawn on by spending and by repaying the debt a
        // Studio ran up while nothing was pointed at it.
        const [spent] = await sql<{ total: string | null }[]>`
          SELECT sum(amount) AS total FROM credit_ledger
          WHERE lot_id = ANY(${lots}) AND entry_type IN ('spend', 'debt_repayment')
        `;
        expect(Number(books!.left) + Math.abs(Number(spent!.total ?? 0))).toBe(Number(books!.bought));

        for (const [key] of charged) {
          const [row] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM credit_charge_settlements WHERE region = 'sg' AND request_id = ${keys[key]!}
          `;
          expect(row!.n).toBe(1);
        }
      }),
      { numRuns: 10 },
    );
  });
});
