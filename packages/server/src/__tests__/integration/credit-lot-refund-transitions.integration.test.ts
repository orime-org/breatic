// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund edges of a lot's lifecycle after the ask, on real Postgres
 * (inner#1410, design §3.2, §5.1, §5.3, §5.5, §6.3, §9).
 *
 * `creditLot.service.ts` is the only module that writes a lot's lifecycle,
 * so the four edges the back office decides live there beside the ask:
 *
 * | Function         | From                          | To               | Ledger                                  |
 * |------------------|-------------------------------|------------------|-----------------------------------------|
 * | `markRefunding`  | `refund_pending`              | `refunding`      | none                                    |
 * | `settleRefund`   | `refund_pending`, `refunding` | `refunded`, 0    | one `refund`, `-remaining`, ref = refund |
 * | `sendBackRefund` | `refunding`                   | `refund_pending` | none                                    |
 * | `rejectRefund`   | `refund_pending`, remaining>0 | `active`, +1     | one `refund_rejected`, 0, ref = op      |
 * | `restoreRefundedCredits` (v9 L9) | `refunded`, `refunding`, `refund_pending` | `active`, attempts unchanged | one `refund_reversed`, ref = op: minus the `refund` row when booked (credits back), else 0 |
 *
 * Every other starting state answers 409 and writes nothing. "Writes
 * nothing" is checked in a transaction that catches the refusal and then
 * commits, so a write made before the throw would survive and show here —
 * letting the refusal roll the transaction back would hide it.
 *
 * `refund_requested_at` is written by the ask alone (L1) and no later edge
 * touches it.
 *
 * The last block runs random sequences of all six edges on one lot and
 * checks the ledger invariants of §9 after every step, against a model of
 * which edge each state allows.
 */

import {
  describe,
  it,
  expect,
  expectTypeOf,
  beforeAll,
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

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import postgres from "postgres";
import { initCore, loadLocales, db, AppError } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { t, type CreditLotEntity } from "@breatic/shared";
import { creditLotService } from "@breatic/domain";
import { openPaymentSource } from "./payment-source.js";

const PG_DRIVER_LOCAL = "credit-lot-refund-transitions-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // Refunds only exist where payments do. The placeholder keys get past the
  // startup check that pairs them with PAYMENT_ENABLED; the lot transitions
  // reach Stripe zero times.
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

type Lifecycle = "active" | "depleted" | "refund_pending" | "refunding" | "refunded";

let seq = 0;

/** A buyer with no studio: every lot here stays unassigned. */
async function seedBuyer(): Promise<string> {
  const n = seq++;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`lot-refund-${n}-${Date.now()}@example.test`}, true) RETURNING id
  `;
  return user!.id;
}

/** A settled payment turned into an unassigned `active` lot. */
async function seedLot(userId: string, credits: number | string): Promise<string> {
  const sourceId = await openPaymentSource(sql);
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (id, user_id, amount_cents, total_cents, status, credits_granted)
    VALUES (${sourceId}, ${userId}, 1000, 1080, 'completed', ${Number(credits)}) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: payment!.id,
    userId,
    purchasedCredits: Number(credits),
  });
  return lot.id;
}

/** Ask for a refund the way the buyer does, which is the only L1 writer. */
async function ask(userId: string, lotId: string): Promise<void> {
  await creditLotService.requestRefund({ lotId, requestingUserId: userId });
}

/**
 * A lot already in `state`, reached by the ask plus direct SQL for the edges
 * after it, so a case about one new function never depends on another.
 * A `refunded` lot gets the `refund` row and zero balance it would have.
 */
async function seedLotIn(
  state: Lifecycle,
  credits = 100,
): Promise<{ userId: string; lotId: string }> {
  const userId = await seedBuyer();
  const lotId = await seedLot(userId, credits);
  if (state === "active") return { userId, lotId };
  if (state === "depleted") {
    await sql`
      INSERT INTO credit_ledger (payer_user_id, actor_user_id, lot_id, entry_type, amount)
      VALUES (${userId}, ${userId}, ${lotId}, 'spend', ${-credits})
    `;
    await sql`
      UPDATE credit_lots SET remaining_credits = 0, lifecycle = 'depleted' WHERE id = ${lotId}
    `;
    return { userId, lotId };
  }
  await ask(userId, lotId);
  if (state === "refunding") {
    await sql`UPDATE credit_lots SET lifecycle = 'refunding' WHERE id = ${lotId}`;
  } else if (state === "refunded") {
    await sql`
      INSERT INTO credit_ledger (payer_user_id, lot_id, entry_type, amount, reference_id)
      VALUES (${userId}, ${lotId}, 'refund', ${-credits}, 're_seeded')
    `;
    await sql`
      UPDATE credit_lots SET remaining_credits = 0, lifecycle = 'refunded' WHERE id = ${lotId}
    `;
  }
  return { userId, lotId };
}

interface LotRow {
  lifecycle: string;
  remaining: string;
  attempts: number;
  requestedAt: string | null;
  /** `refund_requested_at` as microseconds since the epoch, for ordering. */
  requestedUs: number | null;
  updatedAt: string;
  designated: string | null;
}

/** What a lot holds right now, timestamps as Postgres text for exact compare. */
async function readLot(lotId: string): Promise<LotRow> {
  const [row] = await sql<
    {
      lifecycle: string;
      remaining_credits: string;
      refund_attempts: number;
      refund_requested_at: string | null;
      requested_us: string | null;
      updated_at: string;
      designated_studio_id: string | null;
    }[]
  >`
    SELECT lifecycle, remaining_credits, refund_attempts,
           refund_requested_at::text AS refund_requested_at,
           (extract(epoch FROM refund_requested_at) * 1000000)::bigint::text AS requested_us,
           updated_at::text AS updated_at, designated_studio_id
    FROM credit_lots WHERE id = ${lotId}
  `;
  return {
    lifecycle: row!.lifecycle,
    remaining: row!.remaining_credits,
    attempts: row!.refund_attempts,
    requestedAt: row!.refund_requested_at,
    requestedUs: row!.requested_us === null ? null : Number(row!.requested_us),
    updatedAt: row!.updated_at,
    designated: row!.designated_studio_id,
  };
}

interface LedgerRow {
  entryType: string;
  amount: string;
  payer: string | null;
  lotId: string | null;
  studioId: string | null;
  referenceId: string | null;
}

/** Every ledger row on this lot, oldest first. */
async function ledgerOf(lotId: string): Promise<LedgerRow[]> {
  const rows = await sql<
    {
      entry_type: string;
      amount: string;
      payer_user_id: string | null;
      lot_id: string | null;
      studio_id: string | null;
      reference_id: string | null;
    }[]
  >`
    SELECT entry_type, amount, payer_user_id, lot_id, studio_id, reference_id
    FROM credit_ledger WHERE lot_id = ${lotId}
    ORDER BY created_at, id
  `;
  return rows.map((r) => ({
    entryType: r.entry_type,
    amount: r.amount,
    payer: r.payer_user_id,
    lotId: r.lot_id,
    studioId: r.studio_id,
    referenceId: r.reference_id,
  }));
}

/** Run one edge inside its own committed transaction. */
async function inTx<T>(run: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(run);
}

/**
 * Call an edge that must refuse, catch the refusal inside the transaction,
 * and commit. Anything the edge wrote before throwing is then on disk.
 */
async function refusedAndCommitted(run: (tx: DbTx) => Promise<unknown>): Promise<unknown> {
  let caught: unknown = null;
  await db.transaction(async (tx) => {
    try {
      await run(tx);
    } catch (err) {
      caught = err;
    }
  });
  return caught;
}

/** Assert a refusal is the service's typed 409. */
function expectConflict(err: unknown): void {
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ statusCode: 409 });
}

/** The database clock in epoch microseconds, for bracketing a `now()`. */
async function dbClockUs(): Promise<number> {
  const [row] = await sql<{ t: string }[]>`
    SELECT (extract(epoch FROM clock_timestamp()) * 1000000)::bigint::text AS t
  `;
  return Number(row!.t);
}

describe("the four edges take the caller's transaction (§9)", () => {
  it("each requires a DbTx as its second argument, and resolves to the lot", () => {
    // Checked by `tsc --noEmit`: a signature whose transaction is optional
    // (`DbTx | undefined`) or missing fails these lines at type-check time.
    expectTypeOf(creditLotService.markRefunding).parameter(1).toEqualTypeOf<DbTx>();
    expectTypeOf(creditLotService.settleRefund).parameter(1).toEqualTypeOf<DbTx>();
    expectTypeOf(creditLotService.sendBackRefund).parameter(1).toEqualTypeOf<DbTx>();
    expectTypeOf(creditLotService.rejectRefund).parameter(1).toEqualTypeOf<DbTx>();

    expectTypeOf<{ lotId: string }>().toExtend<
      Parameters<typeof creditLotService.markRefunding>[0]
    >();
    expectTypeOf<{ lotId: string; refundId: string }>().toExtend<
      Parameters<typeof creditLotService.settleRefund>[0]
    >();
    expectTypeOf<{ lotId: string }>().toExtend<
      Parameters<typeof creditLotService.sendBackRefund>[0]
    >();
    expectTypeOf<{ lotId: string; operationId: string }>().toExtend<
      Parameters<typeof creditLotService.rejectRefund>[0]
    >();

    expectTypeOf(creditLotService.markRefunding).returns.resolves.toEqualTypeOf<CreditLotEntity>();
    expectTypeOf(creditLotService.settleRefund).returns.resolves.toEqualTypeOf<CreditLotEntity>();
    expectTypeOf(creditLotService.sendBackRefund).returns.resolves.toEqualTypeOf<CreditLotEntity>();
    expectTypeOf(creditLotService.rejectRefund).returns.resolves.toEqualTypeOf<CreditLotEntity>();

    // The runtime half: the four exist on the service and are functions.
    expect(typeof creditLotService.markRefunding).toBe("function");
    expect(typeof creditLotService.settleRefund).toBe("function");
    expect(typeof creditLotService.sendBackRefund).toBe("function");
    expect(typeof creditLotService.rejectRefund).toBe("function");
  });
});

describe("restoreRefundedCredits (v9 L9: refunded | refunding | refund_pending → active, §5.3, §6.3)", () => {
  it("takes the caller's transaction and the disposition it records, and resolves to the lot", () => {
    expectTypeOf(creditLotService.restoreRefundedCredits).parameter(1).toEqualTypeOf<DbTx>();
    expectTypeOf<{ lotId: string; operationId: string }>().toExtend<
      Parameters<typeof creditLotService.restoreRefundedCredits>[0]
    >();
    expectTypeOf(creditLotService.restoreRefundedCredits).returns.resolves.toEqualTypeOf<CreditLotEntity>();
    expect(typeof creditLotService.restoreRefundedCredits).toBe("function");
  });

  it("a refunded lot: active again, the booked credits back, one refund_reversed row of minus the refund row naming the disposition, refund_attempts unchanged", async () => {
    const { userId, lotId } = await seedLotIn("refunded", 37.25);
    await sql`UPDATE credit_lots SET refund_attempts = 1 WHERE id = ${lotId}`;
    const ledgerBefore = await ledgerOf(lotId);
    const operationId = randomUUID();

    const returned = await inTx((tx) => creditLotService.restoreRefundedCredits({ lotId, operationId }, tx));

    expect(returned.lifecycle).toBe("active");
    const after = await readLot(lotId);
    expect(after).toMatchObject({ lifecycle: "active", remaining: "37.250000", attempts: 1, designated: null });
    const ledgerAfter = await ledgerOf(lotId);
    expect(ledgerAfter.slice(0, ledgerBefore.length)).toEqual(ledgerBefore);
    expect(ledgerAfter.slice(ledgerBefore.length)).toEqual([
      { entryType: "refund_reversed", amount: "37.250000", payer: userId, lotId, studioId: null, referenceId: operationId },
    ]);
    const [sum] = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM credit_ledger WHERE lot_id = ${lotId}
    `;
    expect(sum!.total).toBe(after.remaining);
  });

  it("gives back exactly what was booked, not what was bought: a lot spent from before it was refunded", async () => {
    const { userId, lotId } = await seedLotIn("refunding", 100);
    await sql`
      INSERT INTO credit_ledger (payer_user_id, actor_user_id, lot_id, entry_type, amount)
      VALUES (${userId}, ${userId}, ${lotId}, 'spend', -12.345678)
    `;
    await sql`UPDATE credit_lots SET remaining_credits = 87.654322 WHERE id = ${lotId}`;
    await inTx((tx) => creditLotService.settleRefund({ lotId, refundId: "re_spent_then_refunded" }, tx));

    await inTx((tx) => creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx));

    expect((await readLot(lotId)).remaining).toBe("87.654322");
    expect((await ledgerOf(lotId)).filter((r) => r.entryType === "refund_reversed").map((r) => r.amount)).toEqual(["87.654322"]);
  });

  it.each<Lifecycle>(["refunding", "refund_pending"])(
    "a %s lot (credits never left): active, balance unchanged, one zero refund_reversed row",
    async (state) => {
      const { userId, lotId } = await seedLotIn(state, 64);
      const before = await readLot(lotId);
      const operationId = randomUUID();

      await inTx((tx) => creditLotService.restoreRefundedCredits({ lotId, operationId }, tx));

      const after = await readLot(lotId);
      expect(after).toMatchObject({ lifecycle: "active", remaining: "64.000000", attempts: before.attempts, designated: null });
      expect((await ledgerOf(lotId)).filter((r) => r.entryType === "refund_reversed")).toEqual([
        { entryType: "refund_reversed", amount: "0.000000", payer: userId, lotId, studioId: null, referenceId: operationId },
      ]);
    },
  );

  it.each<Lifecycle>(["active", "depleted"])("refuses a %s lot with 409 and writes nothing", async (state) => {
    const { lotId } = await seedLotIn(state);
    const before = await readLot(lotId);
    const ledgerBefore = await ledgerOf(lotId);

    const err = await refusedAndCommitted((tx) =>
      creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx),
    );

    expectConflict(err);
    expect(await readLot(lotId)).toEqual(before);
    expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
  });

  it("refuses a second restore: the lot is active by then, 409, still one refund_reversed row", async () => {
    const { lotId } = await seedLotIn("refunded", 10);
    await inTx((tx) => creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx));
    const before = await readLot(lotId);

    const err = await refusedAndCommitted((tx) =>
      creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx),
    );

    expectConflict(err);
    expect(await readLot(lotId)).toEqual(before);
    expect((await ledgerOf(lotId)).filter((r) => r.entryType === "refund_reversed")).toHaveLength(1);
  });

  it("a restored lot cannot be asked about again: the buyer's ask is 409 with the refund_restored sentence (v9 §5.3)", async () => {
    const { userId, lotId } = await seedLotIn("refunded", 10);
    await inTx((tx) => creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx));

    await expect(ask(userId, lotId)).rejects.toMatchObject({ statusCode: 409, message: t("server.credit.refund_restored") });
    expect((await readLot(lotId)).lifecycle).toBe("active");
  });
});

describe("refund_requested_at (§5.1, L1)", () => {
  it("is null on a lot nobody asked about", async () => {
    const { lotId } = await seedLotIn("active");
    expect((await readLot(lotId)).requestedAt).toBeNull();
  });

  it("is set to the database's now() by the ask", async () => {
    const userId = await seedBuyer();
    const lotId = await seedLot(userId, 100);

    const before = await dbClockUs();
    await ask(userId, lotId);
    const after = await dbClockUs();

    const { requestedUs, lifecycle } = await readLot(lotId);
    expect(lifecycle).toBe("refund_pending");
    expect(requestedUs).not.toBeNull();
    expect(requestedUs!).toBeGreaterThanOrEqual(before);
    expect(requestedUs!).toBeLessThanOrEqual(after);
  });

  it("is left alone by a refused second ask", async () => {
    const { userId, lotId } = await seedLotIn("refund_pending");
    const first = (await readLot(lotId)).requestedAt;
    expect(first).not.toBeNull();

    await expect(ask(userId, lotId)).rejects.toMatchObject({ statusCode: 409 });

    expect((await readLot(lotId)).requestedAt).toBe(first);
  });

  it("survives markRefunding, sendBackRefund and settleRefund unchanged", async () => {
    const { lotId } = await seedLotIn("refund_pending");
    const asked = (await readLot(lotId)).requestedAt;
    expect(asked).not.toBeNull();

    await inTx((tx) => creditLotService.markRefunding({ lotId }, tx));
    expect((await readLot(lotId)).requestedAt).toBe(asked);

    await inTx((tx) => creditLotService.sendBackRefund({ lotId }, tx));
    expect((await readLot(lotId)).requestedAt).toBe(asked);

    await inTx((tx) => creditLotService.markRefunding({ lotId }, tx));
    await inTx((tx) =>
      creditLotService.settleRefund({ lotId, refundId: "re_keep_requested_at" }, tx),
    );
    expect((await readLot(lotId)).requestedAt).toBe(asked);
  });

  it("survives rejectRefund, and a later ask writes it again", async () => {
    // The column is the moment of the ask in flight: the rejection mail
    // prints it. A rejection does not clear it; the next ask is a new ask.
    const { userId, lotId } = await seedLotIn("refund_pending");
    const firstAsk = await readLot(lotId);
    expect(firstAsk.requestedUs).not.toBeNull();

    await inTx((tx) =>
      creditLotService.rejectRefund({ lotId, operationId: randomUUID() }, tx),
    );
    expect((await readLot(lotId)).requestedAt).toBe(firstAsk.requestedAt);

    await ask(userId, lotId);
    const secondAsk = await readLot(lotId);
    expect(secondAsk.requestedUs).not.toBeNull();
    expect(secondAsk.requestedUs!).toBeGreaterThan(firstAsk.requestedUs!);
  });
});

describe("markRefunding (L3: refund_pending → refunding)", () => {
  it("moves a refund_pending lot to refunding and leaves its credits and ledger alone", async () => {
    const { lotId } = await seedLotIn("refund_pending", 42.5);
    const before = await readLot(lotId);
    const ledgerBefore = await ledgerOf(lotId);

    const returned = await inTx((tx) => creditLotService.markRefunding({ lotId }, tx));

    expect(returned.id).toBe(lotId);
    expect(returned.lifecycle).toBe("refunding");
    const after = await readLot(lotId);
    expect(after.lifecycle).toBe("refunding");
    expect(after.remaining).toBe("42.500000");
    expect(after.attempts).toBe(before.attempts);
    expect(after.designated).toBeNull();
    expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
  });

  it.each<Lifecycle>(["active", "depleted", "refunding", "refunded"])(
    "refuses a %s lot with 409 and writes nothing",
    async (state) => {
      const { lotId } = await seedLotIn(state);
      const before = await readLot(lotId);
      const ledgerBefore = await ledgerOf(lotId);

      const err = await refusedAndCommitted((tx) =>
        creditLotService.markRefunding({ lotId }, tx),
      );

      expectConflict(err);
      expect(await readLot(lotId)).toEqual(before);
      expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
    },
  );
});

describe("settleRefund (L4: refund_pending | refunding → refunded, §5.5)", () => {
  it.each<Lifecycle>(["refunding", "refund_pending"])(
    "books a %s lot: refunded, nothing left, one refund row of minus what was left",
    async (state) => {
      const { userId, lotId } = await seedLotIn(state, 37.25);
      const ledgerBefore = await ledgerOf(lotId);
      const refundId = `re_settle_${state}_${Date.now()}`;

      const returned = await inTx((tx) =>
        creditLotService.settleRefund({ lotId, refundId }, tx),
      );

      expect(returned.lifecycle).toBe("refunded");
      expect(returned.remainingCredits).toBe("0.000000");
      const after = await readLot(lotId);
      expect(after.lifecycle).toBe("refunded");
      expect(after.remaining).toBe("0.000000");

      const ledgerAfter = await ledgerOf(lotId);
      expect(ledgerAfter).toHaveLength(ledgerBefore.length + 1);
      const refundRows = ledgerAfter.filter((r) => r.entryType === "refund");
      expect(refundRows).toEqual([
        {
          entryType: "refund",
          amount: "-37.250000",
          payer: userId,
          lotId,
          studioId: null,
          referenceId: refundId,
        },
      ]);
    },
  );

  it("books minus what is left, not minus what was bought", async () => {
    // A refund_pending lot always has its full balance today, but the row is
    // defined as -remaining_credits taken in SQL; a lot that holds less than
    // it was bought for must book exactly what it holds, so the ledger sums
    // to zero afterwards.
    const { userId, lotId } = await seedLotIn("refunding", 100);
    await sql`
      INSERT INTO credit_ledger (payer_user_id, actor_user_id, lot_id, entry_type, amount)
      VALUES (${userId}, ${userId}, ${lotId}, 'spend', -12.345678)
    `;
    await sql`UPDATE credit_lots SET remaining_credits = 87.654322 WHERE id = ${lotId}`;

    await inTx((tx) => creditLotService.settleRefund({ lotId, refundId: "re_partial" }, tx));

    const refundRows = (await ledgerOf(lotId)).filter((r) => r.entryType === "refund");
    expect(refundRows.map((r) => r.amount)).toEqual(["-87.654322"]);
    const [sum] = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM credit_ledger WHERE lot_id = ${lotId}
    `;
    expect(sum!.total).toBe("0.000000");
  });

  it("refuses an already refunded lot with 409 and writes no second refund row", async () => {
    const { lotId } = await seedLotIn("refunding", 50);
    await inTx((tx) => creditLotService.settleRefund({ lotId, refundId: "re_first" }, tx));
    const before = await readLot(lotId);
    const ledgerBefore = await ledgerOf(lotId);

    const err = await refusedAndCommitted((tx) =>
      creditLotService.settleRefund({ lotId, refundId: "re_second" }, tx),
    );

    expectConflict(err);
    expect(await readLot(lotId)).toEqual(before);
    const ledgerAfter = await ledgerOf(lotId);
    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(ledgerAfter.filter((r) => r.entryType === "refund")).toHaveLength(1);
  });

  it.each<Lifecycle>(["active", "depleted", "refunded"])(
    "refuses a %s lot with 409 and writes nothing",
    async (state) => {
      const { lotId } = await seedLotIn(state);
      const before = await readLot(lotId);
      const ledgerBefore = await ledgerOf(lotId);

      const err = await refusedAndCommitted((tx) =>
        creditLotService.settleRefund({ lotId, refundId: `re_refused_${state}` }, tx),
      );

      expectConflict(err);
      expect(await readLot(lotId)).toEqual(before);
      expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
    },
  );

  it("touches no other lot of the same buyer", async () => {
    const userId = await seedBuyer();
    const target = await seedLot(userId, 30);
    const bystanderPending = await seedLot(userId, 20);
    const bystanderActive = await seedLot(userId, 10);
    await ask(userId, target);
    await ask(userId, bystanderPending);
    const pendingBefore = await readLot(bystanderPending);
    const activeBefore = await readLot(bystanderActive);
    const pendingLedger = await ledgerOf(bystanderPending);
    const activeLedger = await ledgerOf(bystanderActive);

    await inTx((tx) => creditLotService.settleRefund({ lotId: target, refundId: "re_one" }, tx));

    expect((await readLot(target)).lifecycle).toBe("refunded");
    expect(await readLot(bystanderPending)).toEqual(pendingBefore);
    expect(await readLot(bystanderActive)).toEqual(activeBefore);
    expect(await ledgerOf(bystanderPending)).toEqual(pendingLedger);
    expect(await ledgerOf(bystanderActive)).toEqual(activeLedger);
    const [count] = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM credit_ledger
      WHERE payer_user_id = ${userId} AND entry_type = 'refund'
    `;
    expect(count!.n).toBe("1");
  });
});

describe("sendBackRefund (L5: refunding → refund_pending)", () => {
  it("moves a refunding lot back to refund_pending and leaves its credits and ledger alone", async () => {
    const { lotId } = await seedLotIn("refunding", 64);
    const before = await readLot(lotId);
    const ledgerBefore = await ledgerOf(lotId);

    const returned = await inTx((tx) => creditLotService.sendBackRefund({ lotId }, tx));

    expect(returned.lifecycle).toBe("refund_pending");
    const after = await readLot(lotId);
    expect(after.lifecycle).toBe("refund_pending");
    expect(after.remaining).toBe("64.000000");
    expect(after.attempts).toBe(before.attempts);
    expect(after.requestedAt).toBe(before.requestedAt);
    expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
  });

  it.each<Lifecycle>(["active", "depleted", "refund_pending", "refunded"])(
    "refuses a %s lot with 409 and writes nothing",
    async (state) => {
      const { lotId } = await seedLotIn(state);
      const before = await readLot(lotId);
      const ledgerBefore = await ledgerOf(lotId);

      const err = await refusedAndCommitted((tx) =>
        creditLotService.sendBackRefund({ lotId }, tx),
      );

      expectConflict(err);
      expect(await readLot(lotId)).toEqual(before);
      expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
    },
  );
});

describe("rejectRefund (L6: refund_pending → active, §5.3)", () => {
  it("returns the lot to active, counts the attempt, and writes one zero refund_rejected row", async () => {
    const { userId, lotId } = await seedLotIn("refund_pending", 75);
    const before = await readLot(lotId);
    const ledgerBefore = await ledgerOf(lotId);
    const operationId = randomUUID();

    const returned = await inTx((tx) =>
      creditLotService.rejectRefund({ lotId, operationId }, tx),
    );

    expect(returned.lifecycle).toBe("active");
    expect(returned.refundAttempts).toBe(before.attempts + 1);
    const after = await readLot(lotId);
    expect(after.lifecycle).toBe("active");
    expect(after.attempts).toBe(before.attempts + 1);
    expect(after.remaining).toBe("75.000000");
    // Back to active, still unassigned: the buyer designates it again.
    expect(after.designated).toBeNull();

    const ledgerAfter = await ledgerOf(lotId);
    expect(ledgerAfter).toHaveLength(ledgerBefore.length + 1);
    expect(ledgerAfter.filter((r) => r.entryType === "refund_rejected")).toEqual([
      {
        entryType: "refund_rejected",
        amount: "0.000000",
        payer: userId,
        lotId,
        studioId: null,
        referenceId: operationId,
      },
    ]);
  });

  it("counts every rejection: a second ask turned down makes refund_attempts 2", async () => {
    const { userId, lotId } = await seedLotIn("refund_pending");
    const first = randomUUID();
    const second = randomUUID();

    await inTx((tx) => creditLotService.rejectRefund({ lotId, operationId: first }, tx));
    await ask(userId, lotId);
    await inTx((tx) => creditLotService.rejectRefund({ lotId, operationId: second }, tx));

    expect((await readLot(lotId)).attempts).toBe(2);
    const rejected = (await ledgerOf(lotId)).filter((r) => r.entryType === "refund_rejected");
    expect(rejected.map((r) => r.referenceId)).toEqual([first, second]);
  });

  it.each<Lifecycle>(["active", "depleted", "refunding", "refunded"])(
    "refuses a %s lot with 409 and writes nothing",
    async (state) => {
      const { lotId } = await seedLotIn(state);
      const before = await readLot(lotId);
      const ledgerBefore = await ledgerOf(lotId);

      const err = await refusedAndCommitted((tx) =>
        creditLotService.rejectRefund({ lotId, operationId: randomUUID() }, tx),
      );

      expectConflict(err);
      expect(await readLot(lotId)).toEqual(before);
      expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
    },
  );

  it("refuses a refund_pending lot with nothing left with 409 and writes nothing", async () => {
    // Only reachable by hand-editing the row today, but the condition is
    // part of the edge: a lot with nothing left has nothing to hand back.
    const { userId, lotId } = await seedLotIn("refund_pending", 20);
    await sql`
      INSERT INTO credit_ledger (payer_user_id, actor_user_id, lot_id, entry_type, amount)
      VALUES (${userId}, ${userId}, ${lotId}, 'spend', -20)
    `;
    await sql`UPDATE credit_lots SET remaining_credits = 0 WHERE id = ${lotId}`;
    const before = await readLot(lotId);
    const ledgerBefore = await ledgerOf(lotId);

    const err = await refusedAndCommitted((tx) =>
      creditLotService.rejectRefund({ lotId, operationId: randomUUID() }, tx),
    );

    expectConflict(err);
    expect(await readLot(lotId)).toEqual(before);
    expect(await ledgerOf(lotId)).toEqual(ledgerBefore);
  });
});

// ── Model test ────────────────────────────────────────────────────────────

type Step = "ask" | "markRefunding" | "settle" | "sendBack" | "reject" | "restore";

/**
 * Which edge each state allows, and where it lands. Null means 409.
 * @param lifecycle - Where the lot stands.
 * @param step - The edge.
 * @param restored - Whether the lot's credits were restored before (v9: no more asks).
 * @returns The state after, or null.
 */
function expectedAfter(lifecycle: Lifecycle, step: Step, restored: boolean): Lifecycle | null {
  switch (step) {
    case "ask":
      return lifecycle === "active" && !restored ? "refund_pending" : null;
    case "restore":
      return lifecycle === "refund_pending" || lifecycle === "refunding" || lifecycle === "refunded" ? "active" : null;
    case "markRefunding":
      return lifecycle === "refund_pending" ? "refunding" : null;
    case "settle":
      return lifecycle === "refund_pending" || lifecycle === "refunding" ? "refunded" : null;
    case "sendBack":
      return lifecycle === "refunding" ? "refund_pending" : null;
    case "reject":
      // Every refund_pending lot in this model still holds its whole balance.
      return lifecycle === "refund_pending" ? "active" : null;
  }
}

/** Run one step; "ok" or "refused" on a 409, anything else rethrown. */
async function runStep(
  step: Step,
  userId: string,
  lotId: string,
  i: number,
): Promise<"ok" | "refused"> {
  try {
    switch (step) {
      case "ask":
        await ask(userId, lotId);
        break;
      case "markRefunding":
        await inTx((tx) => creditLotService.markRefunding({ lotId }, tx));
        break;
      case "settle":
        await inTx((tx) =>
          creditLotService.settleRefund({ lotId, refundId: `re_model_${i}` }, tx),
        );
        break;
      case "sendBack":
        await inTx((tx) => creditLotService.sendBackRefund({ lotId }, tx));
        break;
      case "reject":
        await inTx((tx) =>
          creditLotService.rejectRefund({ lotId, operationId: randomUUID() }, tx),
        );
        break;
      case "restore":
        await inTx((tx) =>
          creditLotService.restoreRefundedCredits({ lotId, operationId: randomUUID() }, tx),
        );
        break;
    }
    return "ok";
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 409) return "refused";
    throw err;
  }
}

/** The §9 ledger figures for one lot, computed by Postgres. */
async function ledgerFacts(lotId: string): Promise<{
  refundRows: number;
  reversedRows: number;
  rejectedRows: number;
  rejectedNonZero: number;
  balanced: boolean;
  totalRows: number;
}> {
  const [row] = await sql<
    {
      refund_rows: string;
      reversed_rows: string;
      rejected_rows: string;
      rejected_non_zero: string;
      balanced: boolean;
      total_rows: string;
    }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = l.id AND entry_type = 'refund')::text
        AS refund_rows,
      (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = l.id AND entry_type = 'refund_reversed')::text
        AS reversed_rows,
      (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = l.id AND entry_type = 'refund_rejected')::text
        AS rejected_rows,
      (SELECT COUNT(*) FROM credit_ledger
         WHERE lot_id = l.id AND entry_type = 'refund_rejected' AND amount <> 0)::text
        AS rejected_non_zero,
      l.remaining_credits =
        (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE lot_id = l.id) AS balanced,
      (SELECT COUNT(*) FROM credit_ledger WHERE lot_id = l.id)::text AS total_rows
    FROM credit_lots l WHERE l.id = ${lotId}
  `;
  return {
    refundRows: Number(row!.refund_rows),
    reversedRows: Number(row!.reversed_rows),
    rejectedRows: Number(row!.rejected_rows),
    rejectedNonZero: Number(row!.rejected_non_zero),
    balanced: row!.balanced,
    totalRows: Number(row!.total_rows),
  };
}

describe("any sequence of refund edges on one lot (§9 ledger invariants)", () => {
  it("keeps the ledger whole after every step and follows the L-table", async () => {
    const stepArb = fc.constantFrom<Step>(
      "ask",
      "markRefunding",
      "settle",
      "sendBack",
      "reject",
      "restore",
    );
    await fc.assert(
      fc.asyncProperty(
        // Thousandths, so the SQL negation has to be exact at numeric scale.
        fc.integer({ min: 1, max: 500_000 }).map((n) => (n / 1000).toFixed(3)),
        fc.array(stepArb, { minLength: 1, maxLength: 12 }),
        async (credits, steps) => {
          const userId = await seedBuyer();
          const lotId = await seedLot(userId, credits);

          let model: Lifecycle = "active";
          let attempts = 0;
          let requestedUs: number | null = null;
          let rowsAtRefund: number | null = null;
          let booked = false;
          let restored = false;

          for (const [i, step] of steps.entries()) {
            const expected = expectedAfter(model, step, restored);
            const outcome = await runStep(step, userId, lotId, i);
            expect(outcome).toBe(expected === null ? "refused" : "ok");
            if (expected !== null) {
              if (step === "reject") attempts += 1;
              if (step === "settle") booked = true;
              if (step === "restore") restored = true;
              model = expected;
            }

            const lot = await readLot(lotId);
            const facts = await ledgerFacts(lotId);

            // The lot follows the transition table.
            expect(lot.lifecycle).toBe(model);
            expect(lot.attempts).toBe(attempts);
            expect(lot.designated).toBeNull();

            // At most one refund row per lot.
            expect(facts.refundRows).toBeLessThanOrEqual(1);
            expect(facts.refundRows).toBe(booked ? 1 : 0);
            // At most one refund_reversed row, and no refund_pending after it (v9 §9).
            expect(facts.reversedRows).toBe(restored ? 1 : 0);
            if (restored) expect(lot.lifecycle).not.toBe("refund_pending");
            // remaining_credits equals the ledger summed over the lot.
            expect(facts.balanced).toBe(true);
            // A refunded lot holds nothing, and gets no row after booking.
            if (model === "refunded") {
              expect(lot.remaining).toBe("0.000000");
              rowsAtRefund ??= facts.totalRows;
              expect(facts.totalRows).toBe(rowsAtRefund);
            } else {
              expect(Number(lot.remaining)).toBe(Number(credits));
            }
            // One zero-amount refund_rejected row per rejection.
            expect(facts.rejectedRows).toBe(attempts);
            expect(facts.rejectedNonZero).toBe(0);

            // refund_requested_at moves only on a successful ask.
            if (step === "ask" && outcome === "ok") {
              expect(lot.requestedUs).not.toBeNull();
              if (requestedUs !== null) {
                expect(lot.requestedUs!).toBeGreaterThan(requestedUs);
              }
              requestedUs = lot.requestedUs;
            } else {
              expect(lot.requestedUs).toBe(requestedUs);
            }
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
