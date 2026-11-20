// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The billing service moves a lot through a refund one edge at a time
 * (inner#1993 §3.3 `refund-steps`, §8.2): each step runs once per operation
 * and step, writes its bell notice in the same transaction, and answers the
 * lot after it; a lot no longer in the edge's starting state is refused with
 * 409 `lot_state_changed` and that refusal is the answer every repeat gets.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { closeDb, initCore, type RefundStepRequest } from "@breatic/core";
import type * as Core from "@breatic/core";
import { applyRefundStep } from "@server/modules/commerce/commerce-refund-steps.service.js";

const track = vi.hoisted(() => vi.fn());
const accountConsent = vi.hoisted(() => vi.fn(async () => ({ analytics: true, ads: false })));

vi.mock("@breatic/core", async (original) => ({
  ...(await original<typeof Core>()),
  trackServerEvent: track,
  accountOnlyConsent: accountConsent,
}));

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "commerce-refund-steps-test" } });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await closeDb();
});

/**
 * A bought lot of 1000 credits in one lifecycle.
 * @param lifecycle - Where it stands.
 * @returns The lot and its owner.
 */
async function lot(lifecycle: string): Promise<{ lotId: string; userId: string }> {
  const userId = randomUUID();
  const sourceId = randomUUID();
  await sql`INSERT INTO users(id,email) VALUES (${userId},${`${userId}@example.test`})`;
  await sql`INSERT INTO credit_sources(id,kind) VALUES (${sourceId},'payment')`;
  const [row] = await sql<{ id: string }[]>`INSERT INTO credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
    VALUES (${sourceId},'payment',${userId},1000,1000,${lifecycle}) RETURNING id`;
  await sql`INSERT INTO credit_ledger(payer_user_id,lot_id,entry_type,amount) VALUES (${userId},${row!.id},'topup','1000')`;
  return { lotId: row!.id, userId };
}

/**
 * Run one step under a fresh operation.
 * @param request - The step.
 * @param operationId - The operation, fresh unless given.
 * @returns The stored answer.
 */
function step(request: RefundStepRequest, operationId: string = randomUUID()): ReturnType<typeof applyRefundStep> {
  return applyRefundStep(operationId, request.step, request);
}

describe("applyRefundStep", () => {
  it("starts an approval and answers the lot after it", async () => {
    const { lotId } = await lot("refund_pending");

    const answer = await step({ lotId, step: "mark_refunding", referenceId: randomUUID(), tell: null });

    expect(answer).toMatchObject({ httpStatus: 200, body: { status: "applied", lot: { lotId, lifecycle: "refunding" } } });
  });

  it("settles the refund, tells the buyer and reports it after the commit", async () => {
    const { lotId, userId } = await lot("refunding");
    const refundId = `re_${randomUUID()}`;

    const answer = await step({ lotId, step: "settle", referenceId: refundId, tell: { kind: "refund_completed", amountCents: 1000, currency: "usd" } });

    expect(answer).toMatchObject({ httpStatus: 200, body: { status: "applied", lot: { lifecycle: "refunded", ledgerSum: "0.000000" } } });
    expect(await sql`SELECT amount::text, reference_id FROM credit_ledger WHERE lot_id = ${lotId} AND entry_type = 'refund'`).toEqual([
      { amount: "-1000.000000", reference_id: refundId },
    ]);
    expect(await sql`SELECT type, payload FROM notifications WHERE user_id = ${userId}`).toEqual([
      { type: "credit.refund_completed", payload: { lotId, credits: "1000.000000", amountCents: 1000, currency: "usd" } },
    ]);
    expect(track).toHaveBeenCalledWith(
      "refund_completed",
      { userId, insertId: `refund:${lotId}`, properties: { credits: 1000, amount_cents: 1000, currency: "usd" } },
      { analytics: true, ads: false },
    );
  });

  it("rejects a request with a zero row naming the disposition and tells the buyer", async () => {
    const { lotId, userId } = await lot("refund_pending");
    const operationId = randomUUID();

    await step({ lotId, step: "reject", referenceId: operationId, tell: { kind: "refund_rejected" } }, operationId);

    expect(await sql`SELECT lifecycle, refund_attempts FROM credit_lots WHERE id = ${lotId}`).toEqual([{ lifecycle: "active", refund_attempts: 1 }]);
    expect(await sql`SELECT amount::text, reference_id FROM credit_ledger WHERE lot_id = ${lotId} AND entry_type = 'refund_rejected'`).toEqual([
      { amount: "0.000000", reference_id: operationId },
    ]);
    expect(await sql`SELECT type FROM notifications WHERE user_id = ${userId}`).toEqual([{ type: "credit.refund_rejected" }]);
    expect(track).not.toHaveBeenCalled();
  });

  it("sends an approval back and restores a settled lot", async () => {
    const back = await lot("refunding");
    expect(await step({ lotId: back.lotId, step: "send_back", referenceId: randomUUID(), tell: null })).toMatchObject({
      body: { status: "applied", lot: { lifecycle: "refund_pending" } },
    });

    const settled = await lot("refunding");
    await step({ lotId: settled.lotId, step: "settle", referenceId: `re_${randomUUID()}`, tell: null });
    const operationId = randomUUID();
    const restored = await step({ lotId: settled.lotId, step: "restore", referenceId: operationId, tell: { kind: "refund_restored" } }, operationId);

    expect(restored).toMatchObject({ body: { status: "applied", lot: { lifecycle: "active", ledgerSum: "1000.000000", everRestored: true } } });
    expect(await sql`SELECT type FROM notifications WHERE user_id = ${settled.userId}`).toEqual([{ type: "credit.refund_restored" }]);
  });

  it("refuses a lot that has moved on, writes nothing, and answers every repeat the same", async () => {
    const { lotId, userId } = await lot("active");
    const operationId = randomUUID();
    const request: RefundStepRequest = { lotId, step: "settle", referenceId: `re_${randomUUID()}`, tell: { kind: "refund_completed", amountCents: 1000, currency: "usd" } };

    const first = await step(request, operationId);
    const again = await step(request, operationId);

    expect(first).toMatchObject({ httpStatus: 409, body: { status: "refused", code: "lot_state_changed", lot: { lotId, lifecycle: "active" } } });
    expect(again).toEqual(first);
    expect(await sql`SELECT count(*)::int AS n FROM credit_ledger WHERE lot_id = ${lotId}`).toEqual([{ n: 1 }]);
    expect(await sql`SELECT 1 FROM notifications WHERE user_id = ${userId}`).toHaveLength(0);
    expect(track).not.toHaveBeenCalled();
  });

  it("answers a repeat of an applied step from the first and moves the lot once", async () => {
    const { lotId, userId } = await lot("refund_pending");
    const operationId = randomUUID();
    const request: RefundStepRequest = { lotId, step: "reject", referenceId: operationId, tell: { kind: "refund_rejected" } };

    const first = await step(request, operationId);

    expect(await step(request, operationId)).toEqual(first);
    expect(await sql`SELECT refund_attempts FROM credit_lots WHERE id = ${lotId}`).toEqual([{ refund_attempts: 1 }]);
    expect(await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId}`).toEqual([{ n: 1 }]);
  });

  it("answers 404 for a lot that does not exist", async () => {
    expect(await step({ lotId: randomUUID(), step: "mark_refunding", referenceId: randomUUID(), tell: null })).toEqual({
      httpStatus: 404,
      body: { code: "lot_not_found" },
    });
  });
});
