// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lot facts the billing service's refund decisions read from the product
 * (inner#1993 §3.3 `refund-lots/facts`): one row per live lot asked for, with
 * its ledger sum and whether it was ever spent from or restored.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { closeDb, initCore } from "@breatic/core";
import { readRefundLotFacts } from "@server/modules/commerce/commerce-refund-lots.service.js";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-refund-lot-facts-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * One lot of 1000 credits bought by a fresh account, with a top-up ledger row.
 * @param lifecycle - Its lifecycle.
 * @returns The lot, its source and its owner.
 */
async function lot(lifecycle = "active"): Promise<{ lotId: string; sourceId: string; userId: string }> {
  const userId = randomUUID();
  const sourceId = randomUUID();
  await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  await sql`INSERT INTO credit_sources(id,kind) VALUES (${sourceId},'payment')`;
  const [row] = await sql<{ id: string }[]>`INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
    VALUES (${sourceId},'payment',${userId},1000,1000,${lifecycle}) RETURNING id`;
  await sql`INSERT INTO credit_ledger(payer_user_id,lot_id,entry_type,amount) VALUES (${userId},${row!.id},'topup','1000')`;
  return { lotId: row!.id, sourceId, userId };
}

describe("readRefundLotFacts", () => {
  it("answers each live lot's facts, its ledger sum and whether it was spent or restored", async () => {
    const untouched = await lot();
    const spent = await lot();
    await sql`INSERT INTO credit_ledger(payer_user_id,lot_id,entry_type,amount) VALUES (${spent.userId},${spent.lotId},'spend','-250')`;
    const restored = await lot("refunded");
    await sql`INSERT INTO credit_ledger(payer_user_id,lot_id,entry_type,amount) VALUES (${restored.userId},${restored.lotId},'refund_reversed','0')`;

    const answer = await readRefundLotFacts([untouched.lotId, spent.lotId, restored.lotId, randomUUID()]);

    expect(answer.httpStatus).toBe(200);
    const rows = new Map((answer.body as Array<{ lotId: string }>).map((r) => [r.lotId, r]));
    expect(rows.size).toBe(3);
    expect(rows.get(untouched.lotId)).toMatchObject({
      userId: untouched.userId, sourceId: untouched.sourceId, sourceKind: "payment", lifecycle: "active",
      purchasedCredits: "1000.000000", remainingCredits: "1000.000000", refundAttempts: 0, refundRequestedAt: null,
      ledgerSum: "1000.000000", everSpent: false, everRestored: false, designated: false,
    });
    expect(rows.get(spent.lotId)).toMatchObject({ ledgerSum: "750.000000", everSpent: true, everRestored: false });
    expect(rows.get(restored.lotId)).toMatchObject({ lifecycle: "refunded", everSpent: false, everRestored: true });
  });
});
