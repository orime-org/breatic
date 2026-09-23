// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The acquisition history — how every credit this account holds got here
 * (task #267).
 *
 * It was the purchase history, built from `payments`, and a screen built from
 * payments can only show purchases. Trial credits are the first credits that
 * came from no payment, so the screen answers a wider question and takes two
 * kinds of row:
 *
 *   1. Rows that opened credits: bought, granted, and whatever a back office
 *      grants later. These come from the lots.
 *
 *   2. Rows that opened none: a checkout still clearing, one the buyer
 *      abandoned. These have no lot and are the reason the old query started
 *      from payments — that half has to survive.
 *
 * What is pinned here:
 *
 *   - Both kinds arrive, and a row says which it is through what it carries:
 *     a granted row has no payment behind it and no price.
 *
 *   - A purchase is dated by its checkout, not by the moment its credits
 *     opened. For a delayed payment method those are days apart, and the
 *     history has always shown the first.
 *
 *   - Paging holds across the two kinds. Both cursor components fall back to
 *     whichever side of the row exists, so neither kind collapses the
 *     ordering — the failure the old comment on this query warned about, from
 *     the other direction.
 *
 * Runs against the testcontainer Postgres started by global-setup.ts.
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
import { initCore } from "@breatic/core";
import type { PurchaseRow } from "@breatic/shared";
import * as paymentService from "@server/modules/payment/payment.service.js";

const PG_DRIVER_LOCAL = "acquisition-history-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

let seq = 0;

/**
 * One account.
 * @returns Its id.
 */
async function seedUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`acq-${seq++}@example.test`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * A purchase that landed: a payment, and the lot it opened.
 * @param userId - Who paid.
 * @param at - When the checkout happened.
 * @param lotAt - When the credits opened; the checkout moment when omitted.
 * @returns The payment's id.
 */
async function seedLandedPurchase(
  userId: string,
  at: string,
  lotAt?: string,
): Promise<string> {
  const source = await sql<{ id: string }[]>`
    INSERT INTO credit_sources (id, kind, created_at)
    VALUES (gen_random_uuid(), 'payment', ${at}) RETURNING id
  `;
  const id = source[0]!.id;
  await sql`
    INSERT INTO payments
      (id, user_id, amount_cents, total_cents, status, credits_granted, created_at)
    VALUES (${id}, ${userId}, 1000, 1080, 'completed', 880, ${at})
  `;
  await sql`
    INSERT INTO credit_lots
      (source_id, source_kind, user_id, purchased_credits, remaining_credits,
       lifecycle, created_at)
    VALUES (${id}, 'payment', ${userId}, 880, 880, 'active', ${lotAt ?? at})
  `;
  return id;
}

/**
 * A checkout that opened no credits — still clearing, or abandoned.
 * @param userId - Who started it.
 * @param at - When.
 * @param status - Where it ended up.
 * @returns The payment's id.
 */
async function seedUnlandedPayment(
  userId: string,
  at: string,
  status: string,
): Promise<string> {
  const source = await sql<{ id: string }[]>`
    INSERT INTO credit_sources (id, kind, created_at)
    VALUES (gen_random_uuid(), 'payment', ${at}) RETURNING id
  `;
  const id = source[0]!.id;
  await sql`
    INSERT INTO payments
      (id, user_id, amount_cents, status, credits_granted, created_at)
    VALUES (${id}, ${userId}, 1000, ${status}, 0, ${at})
  `;
  return id;
}

/**
 * Credits granted to an account, with no payment behind them.
 * @param userId - Who holds them; also the receipt's id.
 * @param at - When.
 * @returns The lot's id.
 */
async function seedGrant(userId: string, at: string): Promise<string> {
  await sql`
    INSERT INTO credit_sources (id, kind, created_at)
    VALUES (${userId}, 'gift', ${at})
  `;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO credit_lots
      (source_id, source_kind, user_id, purchased_credits, remaining_credits,
       lifecycle, created_at)
    VALUES (${userId}, 'gift', ${userId}, 100, 100, 'active', ${at})
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Every row of this account's history, following the cursor to the end.
 * @param userId - Whose history.
 * @param pageSize - How many per request.
 * @returns The rows, in the order they were handed over.
 */
async function readAll(
  userId: string,
  pageSize: number,
): Promise<PurchaseRow[]> {
  const all: PurchaseRow[] = [];
  let cursor: string | undefined;
  // Bounded so a cursor that never advances fails as a test rather than
  // hanging the suite.
  for (let page = 0; page < 20; page += 1) {
    const got = await paymentService.getPurchaseHistory(
      userId,
      String(pageSize),
      cursor,
    );
    all.push(...got.items);
    if (got.nextCursor === null) return all;
    cursor = got.nextCursor;
  }
  throw new Error("the cursor never reached the end");
}

describe("the acquisition history takes both kinds of row", () => {
  it("shows credits that were granted, with no payment and no price", async () => {
    const userId = await seedUser();
    const lotId = await seedGrant(userId, "2026-03-01T10:00:00Z");

    const rows = (await paymentService.getPurchaseHistory(userId, "20", undefined))
      .items;
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.rowId).toBe(lotId);
    expect(row.sourceKind).toBe("gift");
    expect(row.paymentId).toBeNull();
    expect(row.amountCents).toBeNull();
    expect(row.totalCents).toBeNull();
    expect(row.status).toBeNull();
    expect(row.canResend).toBe(false);
    expect(row.creditsGranted).toBe(100);
    expect(row.remainingCredits).toBe(100);
  });

  it("keeps a checkout that opened no credits", async () => {
    const userId = await seedUser();
    const paymentId = await seedUnlandedPayment(
      userId,
      "2026-03-01T10:00:00Z",
      "pending",
    );

    const rows = (await paymentService.getPurchaseHistory(userId, "20", undefined))
      .items;
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.rowId).toBe(paymentId);
    expect(row.paymentId).toBe(paymentId);
    expect(row.sourceKind).toBe("payment");
    expect(row.status).toBe("pending");
    expect(row.amountCents).toBe(1000);
    // No lot behind it, so nothing the lot carries.
    expect(row.remainingCredits).toBeNull();
    expect(row.lifecycle).toBeNull();
  });

  it("puts a purchase and a grant on one list, newest first", async () => {
    const userId = await seedUser();
    await seedLandedPurchase(userId, "2026-03-01T10:00:00Z");
    await seedGrant(userId, "2026-03-02T10:00:00Z");
    await seedUnlandedPayment(userId, "2026-03-03T10:00:00Z", "expired");

    const kinds = (
      await paymentService.getPurchaseHistory(userId, "20", undefined)
    ).items.map((r) => [r.sourceKind, r.status]);

    expect(kinds).toEqual([
      ["payment", "expired"],
      ["gift", null],
      ["payment", "completed"],
    ]);
  });
});

describe("what a row is dated by", () => {
  it("dates a purchase by its checkout, not by when its credits opened", async () => {
    // A delayed payment method completes its session days before the money
    // moves, and the credits open with the money. The history has always
    // shown the first, and a grant beside it is dated by itself.
    const userId = await seedUser();
    await seedLandedPurchase(
      userId,
      "2026-03-01T10:00:00Z",
      "2026-03-05T10:00:00Z",
    );
    await seedGrant(userId, "2026-03-03T10:00:00Z");

    const kinds = (
      await paymentService.getPurchaseHistory(userId, "20", undefined)
    ).items.map((r) => r.sourceKind);

    // Dated by the lot, the purchase would come first.
    expect(kinds).toEqual(["gift", "payment"]);
  });
});

describe("paging across the two kinds", () => {
  it("hands over every row exactly once, at a page size that splits them", async () => {
    const userId = await seedUser();
    const expected: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const at = `2026-04-0${i + 1}T10:00:00Z`;
      expected.push(await seedLandedPurchase(userId, at));
      expected.push(await seedUnlandedPayment(userId, at, "expired"));
    }
    expected.push(await seedGrant(userId, "2026-04-05T10:00:00Z"));

    const seen = (await readAll(userId, 2)).map((r) => r.rowId);

    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen).size).toBe(expected.length);
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});
