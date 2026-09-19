// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asking for a refund, on real Postgres (task #14).
 *
 * This repository writes one transition of the refund flow: a buyer asks,
 * and the lot moves from `active` to `refund_pending`. Deciding what happens
 * next belongs to the back office.
 *
 * Four conditions gate the ask, and each is checked here on its own so that
 * removing any one of them turns a test red. What a test double cannot answer
 * is the row lock: two simultaneous asks resolve to one because Postgres makes
 * the second wait, and nothing short of a real database shows that.
 *
 * Each case seeds its own user, studio and lot. The suite runs serially, but
 * a shared fixture would make assertions depend on rows another case left.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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
import { initCore, loadLocales } from "@breatic/core";
import { creditLotService, creditLotRepo } from "@breatic/domain";

const PG_DRIVER_LOCAL = "credit-refund-request-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // Refunds only exist where payments do. The two placeholder keys get past
  // the startup check that pairs them with PAYMENT_ENABLED; this suite
  // reaches Stripe zero times, because asking is entirely our own database.
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 6,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

interface Fixture {
  userId: string;
  studioId: string;
  projectId: string;
}

/** One buyer, the studio they administer, and a project under it. */
async function seedFixture(): Promise<Fixture> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`refund-${n}-${Date.now()}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`refund-s-${n}-${Date.now()}`}, 'team', 'Refund') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`refund-p-${n}-${Date.now()}`}, 'Refund project')
    RETURNING id
  `;
  return { userId, studioId, projectId: project!.id };
}

/** A settled payment turned into a lot; designate it by passing a studio. */
async function seedLot(
  fx: Fixture,
  credits: number,
  designateTo: string | null = null,
): Promise<string> {
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, amount_cents, total_cents, status, credits_granted)
    VALUES (${fx.userId}, 1000, 1080, 'completed', ${credits}) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: payment!.id,
    userId: fx.userId,
    purchasedCredits: credits,
  });
  if (designateTo !== null) {
    await sql`
      UPDATE credit_lots SET designated_studio_id = ${designateTo} WHERE id = ${lot.id}
    `;
  }
  return lot.id;
}

/** Move a lot's purchase date back, to put it outside the refund window. */
async function ageLot(lotId: string, days: number): Promise<void> {
  await sql`
    UPDATE credit_lots
    SET created_at = now() - ${`${days} days`}::interval
    WHERE id = ${lotId}
  `;
}

/** What a lot holds right now. */
async function readLot(lotId: string): Promise<{
  remaining: string;
  lifecycle: string;
  studio: string | null;
  attempts: number;
}> {
  const [row] = await sql<
    {
      remaining_credits: string;
      lifecycle: string;
      designated_studio_id: string | null;
      refund_attempts: number;
    }[]
  >`
    SELECT remaining_credits, lifecycle, designated_studio_id, refund_attempts
    FROM credit_lots WHERE id = ${lotId}
  `;
  return {
    remaining: row!.remaining_credits,
    lifecycle: row!.lifecycle,
    studio: row!.designated_studio_id,
    attempts: row!.refund_attempts,
  };
}

/** Every ledger row on this lot, summed. */
async function ledgerSum(lotId: string): Promise<string> {
  const [row] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM credit_ledger WHERE lot_id = ${lotId}
  `;
  return row!.total;
}

/** How many ledger rows this lot carries. */
async function ledgerRows(lotId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM credit_ledger WHERE lot_id = ${lotId}
  `;
  return Number(row!.n);
}

/** Ask for a refund on behalf of the lot's buyer. */
async function ask(fx: Fixture, lotId: string): Promise<unknown> {
  return creditLotService.requestRefund({
    lotId,
    requestingUserId: fx.userId,
  });
}

describe("a lot that meets every condition", () => {
  it("moves to refund_pending", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);

    await ask(fx, lotId);

    expect((await readLot(lotId)).lifecycle).toBe("refund_pending");
  });

  it("keeps its balance and its ledger untouched", async () => {
    // The credits leave the account when the money actually goes back, and
    // that step is the back office's. Asking only freezes the lot, so there
    // is nothing to undo if the ask is turned down.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    const rowsBefore = await ledgerRows(lotId);

    await ask(fx, lotId);

    expect((await readLot(lotId)).remaining).toBe("100.000000");
    expect(await ledgerSum(lotId)).toBe("100.000000");
    expect(await ledgerRows(lotId)).toBe(rowsBefore);
  });

  it("leaves refund_attempts alone", async () => {
    // The count answers "was this lot ever turned down", and only the back
    // office writes it. Asking is not a rejection.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);

    await ask(fx, lotId);

    expect((await readLot(lotId)).attempts).toBe(0);
  });
});

describe("a lot that still carries a designation", () => {
  it("refuses the ask with 409", async () => {
    // The buyer releases it themselves. We never do it for them, so a lot
    // pointed at a studio is not in a state where a refund can be asked for.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);

    await expect(ask(fx, lotId)).rejects.toMatchObject({ statusCode: 409 });
    expect((await readLot(lotId)).lifecycle).toBe("active");
  });

  it("can be asked about once the buyer releases it", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);

    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: null,
    });
    await ask(fx, lotId);

    const lot = await readLot(lotId);
    expect(lot.lifecycle).toBe("refund_pending");
    expect(lot.studio).toBeNull();
  });
});

describe("a lot that has been spent from", () => {
  it("refuses the ask with 422", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
      referenceId: `spent-${Date.now()}`,
    });
    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: null,
    });

    await expect(ask(fx, lotId)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("stays refused after the balance is back to what was bought", async () => {
    // This is the case that separates the two possible readings of "nothing
    // spent". A failed generation returns the credits, so the balance climbs
    // back to the full count while the ledger still records the spend. The
    // published promise turns on whether any credit was ever drawn, so the
    // rule reads the ledger; a balance check would let this lot through.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100, fx.studioId);
    await creditLotService.chargeForGeneration({
      projectId: fx.projectId,
      actorUserId: fx.userId,
      amount: 30,
      referenceId: `returned-${Date.now()}`,
    });
    // The return path itself is not built yet, so put the credits back the
    // way it will: one ledger row, and the balance it implies.
    await sql`
      INSERT INTO credit_ledger (payer_user_id, actor_user_id, lot_id, studio_id, entry_type, amount)
      VALUES (${fx.userId}, ${fx.userId}, ${lotId}, ${fx.studioId}, 'refund', 30)
    `;
    await sql`
      UPDATE credit_lots SET remaining_credits = 100 WHERE id = ${lotId}
    `;
    await creditLotService.designateLot({
      lotId,
      requestingUserId: fx.userId,
      studioId: null,
    });

    expect((await readLot(lotId)).remaining).toBe("100.000000");
    await expect(ask(fx, lotId)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("a lot past the refund window", () => {
  it("refuses the ask with 422 when it was never asked about", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    await ageLot(lotId, 31);

    await expect(ask(fx, lotId)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("accepts the ask when the buyer already asked once inside the window", async () => {
    // The buyer exercised the right while the window was open; how long the
    // decision took afterwards is our side of it. `refund_attempts` above
    // zero is the proof, because the only path that raises it is a turned
    // down ask, and asking checks the window.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    await ageLot(lotId, 31);
    await sql`
      UPDATE credit_lots SET refund_attempts = 1 WHERE id = ${lotId}
    `;

    await ask(fx, lotId);

    expect((await readLot(lotId)).lifecycle).toBe("refund_pending");
  });
});

describe("a lot already in the refund flow", () => {
  it("refuses a second ask with 409", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    await ask(fx, lotId);

    await expect(ask(fx, lotId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("cannot be designated to a studio", async () => {
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    await ask(fx, lotId);

    await expect(
      creditLotService.designateLot({
        lotId,
        requestingUserId: fx.userId,
        studioId: fx.studioId,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("cannot be spent", async () => {
    // Two conditions each keep it out of the charge: it is not `active`, and
    // it carries no designation. Either one alone would do it.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);
    await ask(fx, lotId);

    expect(await creditLotRepo.listSpendableLots(fx.studioId)).toEqual([]);
    expect(
      Number(await creditLotRepo.sumSpendableForStudio(fx.studioId)),
    ).toBe(0);
  });
});

describe("a lot belonging to someone else", () => {
  it("answers 404 rather than saying whose it is", async () => {
    const mine = await seedFixture();
    const theirs = await seedFixture();
    const lotId = await seedLot(theirs, 100);

    await expect(ask(mine, lotId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await readLot(lotId)).lifecycle).toBe("active");
  });
});

describe("two asks arriving together", () => {
  it("resolves to one, on the row lock", async () => {
    // Without the lock both transactions read `active` and both write, and
    // the buyer's single lot is asked about twice.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 100);

    const results = await Promise.allSettled([ask(fx, lotId), ask(fx, lotId)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused).toMatchObject({ reason: { statusCode: 409 } });
    expect((await readLot(lotId)).lifecycle).toBe("refund_pending");
  });
});

describe("the overview once a purchase is under refund", () => {
  it("reports it as a third figure, so the three still add up to what is held", async () => {
    // The first two figures only count `active` lots, so without a third one
    // the total drops by this purchase the moment it is asked about, with
    // nothing on the screen saying where it went.
    const fx = await seedFixture();
    const assigned = await seedLot(fx, 100, fx.studioId);
    await seedLot(fx, 40);
    const asked = await seedLot(fx, 25);

    await ask(fx, asked);

    const overview = await creditLotService.getOverview(fx.userId);
    const held =
      overview.assignedCredits +
      overview.unassignedCredits +
      overview.underRefundCredits;
    expect(overview.underRefundCredits).toBe(25);
    expect(held).toBe(165);
    expect(assigned).toBeTruthy();
  });

  it("stops counting a purchase whose money went back", async () => {
    // A refunded purchase is no longer held: the money is with the buyer.
    const fx = await seedFixture();
    const lotId = await seedLot(fx, 60);
    await ask(fx, lotId);
    await sql`UPDATE credit_lots SET lifecycle = 'refunded' WHERE id = ${lotId}`;

    const overview = await creditLotService.getOverview(fx.userId);

    expect(overview.underRefundCredits).toBe(0);
  });
});
