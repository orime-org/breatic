// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The billing service grants a completed payment through the product
 * (inner#1993 §3.3 `payment-grants`): the product writes the payment's receipt
 * and its lot in one transaction, answers the lot and when it was granted, and
 * answers the same for any repeat. A payment whose lot already exists is
 * answered with that lot; a receipt with other figures under the same id is a
 * conflict; an account that does not exist is refused.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { closeDb, initCore } from "@breatic/core";
import type { PaymentGrantRequest } from "@breatic/core";
import { grantPayment } from "@server/modules/commerce/payment-grant.service.js";
import { openPaymentSource, recordPaymentReceipt } from "./payment-source.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-payment-grant-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * One account.
 * @returns Its id.
 */
async function account(): Promise<string> {
  const userId = randomUUID();
  await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  return userId;
}

/**
 * A grant request for 880 credits bought for 1000 cents plus 120 tax.
 * @param userId - The buyer.
 * @returns The request.
 */
function request(userId: string): PaymentGrantRequest {
  return {
    userId,
    purchasedCredits: 880,
    amountCents: 1000,
    taxCents: 120,
    totalCents: 1120,
    currency: "usd",
    orderedAt: "2026-11-19T10:00:00.000Z",
    conversion: { consent: { analytics: false, ads: false }, click: null, transactionId: "tx-1" },
  };
}

describe("grantPayment", () => {
  it("writes the receipt and the lot once and answers the lot", async () => {
    const userId = await account();
    const paymentId = randomUUID();

    const answer = await grantPayment(paymentId, request(userId));

    expect(answer.httpStatus).toBe(200);
    const body = answer.body as { lotId: string; grantedAt: string };
    const lots = await sql`SELECT id, source_kind, purchased_credits::text AS credits, user_id FROM credit_lots WHERE source_id = ${paymentId}`;
    expect(lots).toEqual([{ id: body.lotId, source_kind: "payment", credits: "880.000000", user_id: userId }]);
    expect(await sql`SELECT amount_cents, tax_cents, total_cents, currency, credits_granted::text AS credits, ordered_at FROM payment_receipts WHERE id = ${paymentId}`).toEqual([
      { amount_cents: 1000, tax_cents: 120, total_cents: 1120, currency: "usd", credits: "880.000000", ordered_at: new Date("2026-11-19T10:00:00.000Z") },
    ]);
    expect(Number.isNaN(Date.parse(body.grantedAt))).toBe(false);
  });

  it("answers a repeat with the same lot and grants nothing more", async () => {
    const userId = await account();
    const paymentId = randomUUID();
    const first = await grantPayment(paymentId, request(userId));

    const second = await grantPayment(paymentId, request(userId));

    expect(second).toEqual(first);
    expect(await sql`SELECT count(*)::int AS n FROM credit_lots WHERE source_id = ${paymentId}`).toEqual([{ n: 1 }]);
    expect(await sql`SELECT count(*)::int AS n FROM credit_ledger l JOIN credit_lots c ON c.id = l.lot_id WHERE c.source_id = ${paymentId}`).toEqual([{ n: 1 }]);
  });

  it("answers a payment granted before the move with its existing lot", async () => {
    const userId = await account();
    const paymentId = await openPaymentSource(sql);
    await recordPaymentReceipt(sql, { id: paymentId, userId, amountCents: 1000, taxCents: 120, totalCents: 1120, credits: 880 });
    const [lot] = await sql<{ id: string; created_at: Date }[]>`
      INSERT INTO credit_lots (source_id, source_kind, user_id, purchased_credits, remaining_credits, lifecycle)
      VALUES (${paymentId}, 'payment', ${userId}, 880, 880, 'active') RETURNING id, created_at`;

    const answer = await grantPayment(paymentId, request(userId));

    expect(answer).toEqual({ httpStatus: 200, body: { lotId: lot!.id, grantedAt: lot!.created_at.toISOString() } });
    expect(await sql`SELECT count(*)::int AS n FROM credit_lots WHERE source_id = ${paymentId}`).toEqual([{ n: 1 }]);
  });

  it("refuses a receipt that already says something else about the payment", async () => {
    const userId = await account();
    const paymentId = await openPaymentSource(sql);
    await recordPaymentReceipt(sql, { id: paymentId, userId, amountCents: 999, credits: 880 });

    const answer = await grantPayment(paymentId, request(userId));

    expect(answer).toEqual({ httpStatus: 409, body: { code: "receipt_conflict" } });
    expect(await sql`SELECT count(*)::int AS n FROM credit_lots WHERE source_id = ${paymentId}`).toEqual([{ n: 0 }]);
  });

  it("refuses an account that does not exist", async () => {
    const answer = await grantPayment(randomUUID(), request(randomUUID()));

    expect(answer).toEqual({ httpStatus: 404, body: { code: "account_not_found" } });
  });
});
