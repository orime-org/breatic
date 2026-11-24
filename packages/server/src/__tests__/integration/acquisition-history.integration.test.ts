// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The acquisition history — how every credit this account holds got here
 * (task #267), the product's half: its own lots (inner#1993 §3.2 #5).
 *
 * Payments that opened no lot come from the billing service and are covered
 * in commerce-purchase-history; this suite runs a deployment that sells
 * nothing, so the history is the lots alone.
 *
 * What is pinned here:
 *
 *   - A granted row says what it is through what it carries: no payment
 *     behind it and no price.
 *
 *   - A purchase is dated by its checkout (its receipt's `ordered_at`), not
 *     by the moment its credits opened. For a delayed payment method those
 *     are days apart, and the history has always shown the first.
 *
 *   - Paging holds across bought and granted rows. Both cursor components
 *     fall back to whichever side of the row exists, so neither kind
 *     collapses the ordering.
 *
 * Runs against the testcontainer Postgres started by @breatic/integration-tests/containers.
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
import { readPurchaseHistory } from "@server/modules/commerce/purchase-history.service.js";
import { openPaymentSource } from "./payment-source.js";

const PG_DRIVER_LOCAL = "acquisition-history-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  // No billing service: the history is the product's own lots.
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
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
 * A purchase that landed: its receipt, and the lot it opened.
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
  const id = await openPaymentSource(sql, at);
  await sql`
    INSERT INTO payment_receipts
      (id, user_id, amount_cents, total_cents, currency, credits_granted, ordered_at)
    VALUES (${id}, ${userId}, 1000, 1080, 'usd', 880, ${at})
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
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios(created_by_user_id,slug,type,name) VALUES(${userId},${`acq-gift-${seq++}`},'personal','Gift') RETURNING id
  `;
  await sql`INSERT INTO credit_gifts(id,source_kind,origin,target_user_id,personal_studio_id,credits,created_at)
    VALUES(${userId},'gift','registration',${userId},${studio!.id},100,${at})`;
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
    const got = await readPurchaseHistory(userId, String(pageSize), cursor);
    all.push(...got.items);
    if (got.nextCursor === null) return all;
    cursor = got.nextCursor;
  }
  throw new Error("the cursor never reached the end");
}

describe("the acquisition history takes bought and granted rows", () => {
  it("shows credits that were granted, with no payment and no price", async () => {
    const userId = await seedUser();
    const lotId = await seedGrant(userId, "2026-03-01T10:00:00Z");

    const rows = (await readPurchaseHistory(userId, "20", undefined))
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
    expect(row.creditsGranted).toBe("100.000000");
    expect(row.remainingCredits).toBe("100.000000");
  });

  it("puts a purchase and a grant on one list, newest first", async () => {
    const userId = await seedUser();
    await seedLandedPurchase(userId, "2026-03-01T10:00:00Z");
    await seedGrant(userId, "2026-03-02T10:00:00Z");

    const kinds = (
      await readPurchaseHistory(userId, "20", undefined)
    ).items.map((r) => [r.sourceKind, r.status]);

    expect(kinds).toEqual([
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
      await readPurchaseHistory(userId, "20", undefined)
    ).items.map((r) => r.sourceKind);

    // Dated by the lot, the purchase would come first.
    expect(kinds).toEqual(["gift", "payment"]);
  });
});

describe("paging across bought and granted rows", () => {
  it("hands over every row exactly once, at a page size that splits them", async () => {
    const userId = await seedUser();
    const expected: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const at = `2026-04-0${i + 1}T10:00:00Z`;
      expected.push(await seedLandedPurchase(userId, at));
    }
    // Same instant as a purchase, so the page boundary falls inside the tie
    // and the id component has to order a bought row against a granted one.
    expected.push(await seedGrant(userId, "2026-04-03T10:00:00Z"));

    const seen = (await readAll(userId, 2)).map((r) => r.rowId);

    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen).size).toBe(expected.length);
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});
